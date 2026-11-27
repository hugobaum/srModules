/**
 * YouTube / YouTube Music Pure AdBlock Filter for Shadowrocket
 *
 * 設計原則：
 * 1. 僅過濾廣告欄位與廣告卡片（不偽造會員狀態、不觸碰觀看紀錄／字幕／正常媒體流）。
 * 2. 同時支援 Binary Protobuf（iOS 原生 App，binary-body-mode=1）與 JSON 回應。
 * 3. Protobuf 採「無損線層解碼＋內容特徵驗證＋安全白名單保護」策略：
 *    - 未異動欄位 100% 保留原始位元組，避免 YouTube 新增欄位時因靜態 .proto 缺失而斷播。
 *    - 剔除任何欄位前均先核對核心保護標記（watchtime / playback / timedtext / 媒體清單），防止誤殺。
 * 4. 零外部依賴，不依賴瀏覽器 TextDecoder/TextEncoder，完全相容 Shadowrocket JavaScriptCore。
 */

(function () {
  "use strict";

  if (typeof $response === "undefined") {
    $done({});
    return;
  }

  var url = typeof $request !== "undefined" && $request && $request.url ? String($request.url) : "";
  var args = parseArguments(typeof $argument !== "undefined" ? $argument : "");
  var DEBUG = Boolean(args.debug);

  var MAX_RECURSION_DEPTH = 14;
  var TAG_AD_SLOT_RENDERER = 424701016;
  var TAG_ELEMENT_RENDERER = 153515154;

  // PlayerResponse 核心必保留欄位編號（絕不剔除）
  var PLAYER_CORE_FIELDS = {
    1: true,  // responseContext
    2: true,  // playabilityStatus
    4: true,  // streamingData
    9: true,  // playbackTracking（觀看紀錄 watchtime / playback / qoe）
    10: true, // captions（字幕 timedtext）
    11: true  // videoDetails
  };

  // PlayerResponse 已驗證之廣告排程頂層欄位編號（涵蓋片頭、片中、片尾廣告）
  var PLAYER_AD_FIELDS = {
    7: true,  // adPlacements
    42: true  // adSlots
  };

  // 核心保護特徵（小寫 ASCII）：以二進位 Protobuf 實際包含的字串值與 JSON 鍵名為主
  // 只要欄位內出現以下任一字串，絕不整欄剔除（避免誤殺觀看紀錄、字幕與播放回報）
  var PROTECTED_CORE_MARKERS = [
    "api/stats/watchtime",
    "api/stats/playback",
    "api/stats/qoe",
    "api/timedtext",
    "captiontracks",
    "hlsmanifesturl",
    "serverabrstreamingurl"
  ];

  // PlayerResponse 頂層廣告欄位特徵（小寫 ASCII）
  var PLAYER_AD_MARKERS = [
    "doubleclick.net",
    "googleadservices.com",
    "pagead/",
    "api/stats/ads",
    "adformat=",
    "slot_entry_trigger",
    "player_bytes_ad_layout",
    "client_forecasting_ad_renderer",
    "layout_exit_normal_triggers",
    "ad_placement",
    "ad_slot",
    "ad_break",
    "instream_video_ad",
    "ad_pod",
    "invideo_overlay",
    "ad_intro",
    "fulfillment_content",
    "adunit"
  ];

  // Feed / Search / Next / Shorts 單一廣告卡片特徵（小寫 ASCII）
  var FEED_AD_MARKERS = [
    "ad_slot",
    "in_feed_ad",
    "display_ad",
    "product_carousel",
    "shopping_carousel",
    "brand_video",
    "text_search_ad",
    "landscape_image_wide_button",
    "app_promo_ad",
    "shorts_ad",
    "above_feed_ad",
    "watch_next_ad",
    "ad_companion",
    "ad_badge",
    "visit_advertiser",
    "ad_logging_data",
    "pagead/",
    "googleadservices.com",
    "doubleclick.net"
  ];

  // JSON 模式需移除的廣告鍵名
  var JSON_AD_KEYS = {
    adPlacements: true,
    playerAds: true,
    adSlots: true,
    adBreakHeartbeatParams: true,
    adBreakParams: true,
    adSlotRenderer: true,
    promotedSparklesWebRenderer: true,
    promotedSparklesTextSearchRenderer: true,
    compactPromotedItemRenderer: true,
    displayAdRenderer: true,
    bannerPromoRenderer: true,
    statementBannerRenderer: true,
    mealbarPromoRenderer: true,
    primetimePromoRenderer: true,
    searchPyvRenderer: true,
    inFeedAdLayoutRenderer: true,
    actionCompanionAdRenderer: true,
    instreamVideoAdRenderer: true,
    linearAdSequenceRenderer: true
  };

  function logDebug(msg) {
    if (DEBUG && typeof console !== "undefined" && console.log) {
      console.log("[yt-adblock] " + msg);
    }
  }

  function parseArguments(raw) {
    var result = { debug: false };
    if (!raw || typeof raw !== "string") {
      return result;
    }
    var trimmed = raw.trim();
    if (!trimmed) {
      return result;
    }
    if (trimmed.charAt(0) === "{") {
      try {
        var obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object") {
          result.debug = obj.debug === true || obj.debug === "true" || obj.debug === 1;
        }
        return result;
      } catch (e) {
        // 回退為 key=value 解析
      }
    }
    var parts = trimmed.split(/[&,]/);
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv.length >= 2) {
        var k = kv[0].trim();
        var v = kv.slice(1).join("=").trim().toLowerCase();
        if (k === "debug") {
          result.debug = v === "true" || v === "1" || v === "yes";
        }
      }
    }
    return result;
  }

  function detectEndpoint(requestUrl) {
    if (requestUrl.indexOf("/youtubei/v1/player") !== -1) return "player";
    if (requestUrl.indexOf("/youtubei/v1/get_watch") !== -1) return "get_watch";
    if (requestUrl.indexOf("/youtubei/v1/browse") !== -1) return "browse";
    if (requestUrl.indexOf("/youtubei/v1/next") !== -1) return "next";
    if (requestUrl.indexOf("/youtubei/v1/search") !== -1) return "search";
    if (requestUrl.indexOf("/youtubei/v1/reel/reel_watch_sequence") !== -1) return "reel";
    return "unknown";
  }

  // ---------------------------------------------------------------------------
  // 基礎位元組與 UTF-8／ASCII 工具（無瀏覽器 API 依賴）
  // ---------------------------------------------------------------------------

  function toUint8Array(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function isLikelyJsonBytes(bytes) {
    for (var i = 0; i < bytes.length && i < 32; i++) {
      var b = bytes[i];
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
      return b === 0x7b || b === 0x5b; // '{' or '['
    }
    return false;
  }

  function bytesToUtf8(bytes) {
    var out = "";
    var i = 0;
    var len = bytes.length;
    while (i < len) {
      var c = bytes[i++];
      if (c < 0x80) {
        out += String.fromCharCode(c);
      } else if ((c & 0xe0) === 0xc0 && i < len) {
        var c2 = bytes[i++];
        out += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
      } else if ((c & 0xf0) === 0xe0 && i + 1 < len) {
        var c2b = bytes[i++];
        var c3 = bytes[i++];
        out += String.fromCharCode(((c & 0x0f) << 12) | ((c2b & 0x3f) << 6) | (c3 & 0x3f));
      } else if ((c & 0xf8) === 0xf0 && i + 2 < len) {
        var cp =
          ((c & 0x07) << 18) |
          ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function utf8ToBytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        var next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
          i++;
        }
      }
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      }
    }
    return new Uint8Array(out);
  }

  // 直接對位元組做不分大小寫的 ASCII 子字串搜尋（避免配置大量中間字串）
  function containsAsciiMarker(bytes, markerLower) {
    var mLen = markerLower.length;
    var bLen = bytes.length;
    if (mLen === 0 || bLen < mLen) return false;
    var first = markerLower.charCodeAt(0);
    var firstUpper = first >= 97 && first <= 122 ? first - 32 : first;
    var limit = bLen - mLen;
    for (var i = 0; i <= limit; i++) {
      var b0 = bytes[i];
      if (b0 !== first && b0 !== firstUpper) continue;
      var matched = true;
      for (var j = 1; j < mLen; j++) {
        var bj = bytes[i + j];
        if (bj >= 65 && bj <= 90) bj += 32;
        if (bj !== markerLower.charCodeAt(j)) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
    return false;
  }

  function containsAnyMarker(bytes, markers) {
    for (var i = 0; i < markers.length; i++) {
      if (containsAsciiMarker(bytes, markers[i])) return true;
    }
    return false;
  }

  function hasProtectedCoreMarker(bytes) {
    return containsAnyMarker(bytes, PROTECTED_CORE_MARKERS);
  }

  function hasPlayerAdMarker(bytes) {
    return containsAnyMarker(bytes, PLAYER_AD_MARKERS);
  }

  function hasFeedAdMarker(bytes) {
    return containsAnyMarker(bytes, FEED_AD_MARKERS);
  }

  // ---------------------------------------------------------------------------
  // 無損 Protobuf Wire-Level 解碼與重建
  // ---------------------------------------------------------------------------

  function readVarint(buf, pos, end) {
    var value = 0;
    var multiplier = 1;
    var count = 0;
    while (pos < end && count < 10) {
      var b = buf[pos++];
      if (count < 7) {
        value += (b & 0x7f) * multiplier;
        multiplier *= 128;
      }
      count++;
      if ((b & 0x80) === 0) {
        return { value: value, nextPos: pos, byteCount: count };
      }
    }
    return null;
  }

  function encodeVarint(num) {
    var out = [];
    var n = num;
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n & 0x7f);
    return new Uint8Array(out);
  }

  function decodeFields(buf) {
    var fields = [];
    var pos = 0;
    var end = buf.length;
    while (pos < end) {
      var fieldStart = pos;
      var tagRes = readVarint(buf, pos, end);
      if (!tagRes || tagRes.byteCount > 5) return null;
      var tag = tagRes.value;
      var wireType = tag % 8;
      var fieldNumber = Math.floor(tag / 8);
      if (fieldNumber < 1 || fieldNumber > 536870911) return null;

      var tagEnd = tagRes.nextPos;
      pos = tagEnd;

      if (wireType === 0) {
        var valRes = readVarint(buf, pos, end);
        if (!valRes) return null;
        pos = valRes.nextPos;
        fields.push({
          fieldNumber: fieldNumber,
          wireType: 0,
          fullRaw: buf.subarray(fieldStart, pos)
        });
      } else if (wireType === 1) {
        if (pos + 8 > end) return null;
        pos += 8;
        fields.push({
          fieldNumber: fieldNumber,
          wireType: 1,
          fullRaw: buf.subarray(fieldStart, pos)
        });
      } else if (wireType === 2) {
        var lenRes = readVarint(buf, pos, end);
        if (!lenRes || lenRes.byteCount > 5) return null;
        var len = lenRes.value;
        var payloadStart = lenRes.nextPos;
        if (len < 0 || payloadStart + len > end) return null;
        pos = payloadStart + len;
        fields.push({
          fieldNumber: fieldNumber,
          wireType: 2,
          rawTag: buf.subarray(fieldStart, tagEnd),
          payload: buf.subarray(payloadStart, pos),
          fullRaw: buf.subarray(fieldStart, pos)
        });
      } else if (wireType === 5) {
        if (pos + 4 > end) return null;
        pos += 4;
        fields.push({
          fieldNumber: fieldNumber,
          wireType: 5,
          fullRaw: buf.subarray(fieldStart, pos)
        });
      } else {
        // wireType 3/4/6/7 不視為標準可編輯訊息
        return null;
      }
    }
    return fields;
  }

  function concatChunks(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) {
      total += chunks[i].length;
    }
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  function rebuildLengthDelimitedField(rawTag, newPayload) {
    var lenBytes = encodeVarint(newPayload.length);
    var out = new Uint8Array(rawTag.length + lenBytes.length + newPayload.length);
    out.set(rawTag, 0);
    out.set(lenBytes, rawTag.length);
    out.set(newPayload, rawTag.length + lenBytes.length);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Protobuf 廣告過濾邏輯
  // ---------------------------------------------------------------------------

  // 嚴格辨識一個 Protobuf 訊息是否為 PlayerResponse（避免在 get_watch 巢狀結構中誤判其他訊息）
  function isPlayerResponseFields(fields) {
    if (!fields || fields.length < 2) return false;
    var hasResponseContext = false;
    var hasCorePlaybackPayload = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.wireType !== 2 || f.payload.length === 0) continue;
      if (f.fieldNumber === 1) {
        hasResponseContext = true;
      } else if (f.fieldNumber === 4 || f.fieldNumber === 9 || f.fieldNumber === 11) {
        if (
          containsAsciiMarker(f.payload, "googlevideo.com/videoplayback") ||
          containsAsciiMarker(f.payload, "api/stats/watchtime") ||
          containsAsciiMarker(f.payload, "api/stats/playback") ||
          containsAsciiMarker(f.payload, "api/stats/qoe") ||
          containsAsciiMarker(f.payload, "manifest.googlevideo.com") ||
          containsAsciiMarker(f.payload, "video/mp4") ||
          containsAsciiMarker(f.payload, "audio/mp4") ||
          containsAsciiMarker(f.payload, "video/webm")
        ) {
          hasCorePlaybackPayload = true;
        }
      }
    }
    return hasResponseContext && hasCorePlaybackPayload;
  }

  function filterPlayerProtobuf(buf, stats) {
    var fields = decodeFields(buf);
    if (!fields || !isPlayerResponseFields(fields)) {
      return { changed: false, bytes: buf };
    }

    var chunks = [];
    var changed = false;

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (DEBUG) {
        stats.seenPlayerFields.push(f.fieldNumber);
      }
      if (f.wireType === 2 && f.payload.length > 0) {
        // 核心播放／字幕／觀看紀錄欄位絕不剔除
        if (PLAYER_CORE_FIELDS[f.fieldNumber]) {
          chunks.push(f.fullRaw);
          continue;
        }
        // 已驗證的片頭／片中廣告排程欄位（7: adPlacements, 42: adSlots）直接剔除，
        // 避免片中時間點無網址字串或內嵌 adPlayerResponse 含 qoe 而漏攔
        if (PLAYER_AD_FIELDS[f.fieldNumber]) {
          changed = true;
          stats.removedPlayerFields.push(f.fieldNumber);
          continue;
        }
        // 其他非核心欄位（如 playerAds 等）：命中廣告特徵即剔除
        if (hasPlayerAdMarker(f.payload)) {
          changed = true;
          stats.removedPlayerFields.push(f.fieldNumber);
          continue;
        }
      }
      chunks.push(f.fullRaw);
    }

    return changed ? { changed: true, bytes: concatChunks(chunks) } : { changed: false, bytes: buf };
  }

  // 判斷剔除廣告子節點後，外殼是否僅剩極小 metadata（避免在頁面上留下空白廣告卡片）
  function isOnlyTinyMetadata(buf) {
    if (buf.length === 0) return true;
    if (buf.length > 256) return false;
    var fields = decodeFields(buf);
    if (!fields) return false;
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].wireType === 2 && fields[i].payload.length > 128) {
        return false;
      }
    }
    return true;
  }

  // 高效能 O(N) 樹狀過濾：不在中介容器重複掃描整段位元組，
  // 僅做 varint 跳轉並針對 adSlotRenderer (424701016) 與葉節點 elementRenderer (153515154) 檢查。
  function filterFeedProtobuf(buf, depth, isReelEndpoint, stats) {
    if (depth > MAX_RECURSION_DEPTH || buf.length < 4) {
      return { changed: false, bytes: buf };
    }
    var fields = decodeFields(buf);
    if (!fields || fields.length === 0) {
      return { changed: false, bytes: buf };
    }

    var chunks = [];
    var changed = false;

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.wireType !== 2 || f.payload.length === 0) {
        chunks.push(f.fullRaw);
        continue;
      }

      // 1. 明確 adSlotRenderer 標籤：O(1) 直接剔除
      if (f.fieldNumber === TAG_AD_SLOT_RENDERER) {
        changed = true;
        stats.removedFeedItems++;
        continue;
      }

      // 2. 葉節點 elementRenderer：僅對單卡小區塊掃一次廣告特徵
      if (f.fieldNumber === TAG_ELEMENT_RENDERER) {
        if (f.payload.length <= 131072 && hasFeedAdMarker(f.payload)) {
          changed = true;
          stats.removedFeedItems++;
          continue;
        }
        chunks.push(f.fullRaw);
        continue;
      }

      // 3. Shorts 佇列單筆廣告項目
      if (isReelEndpoint && depth <= 2 && f.payload.length <= 262144) {
        if (
          containsAsciiMarker(f.payload, "shorts_ad") ||
          containsAsciiMarker(f.payload, "ad_slot") ||
          containsAsciiMarker(f.payload, "doubleclick.net") ||
          containsAsciiMarker(f.payload, "googleadservices.com") ||
          containsAsciiMarker(f.payload, "pagead/")
        ) {
          var sub = decodeFields(f.payload);
          if (sub && sub.length <= 16) {
            changed = true;
            stats.removedFeedItems++;
            continue;
          }
        }
      }

      // 4. 輕量向下遞迴（純字串或非 Protobuf 欄位會在 decodeFields 第一個 tag 立即返回 null）
      if (f.payload.length >= 8) {
        var childRes = filterFeedProtobuf(f.payload, depth + 1, isReelEndpoint, stats);
        if (childRes.changed) {
          changed = true;
          if (
            childRes.bytes.length === 0 ||
            (f.payload.length <= 131072 && isOnlyTinyMetadata(childRes.bytes))
          ) {
            continue;
          }
          chunks.push(rebuildLengthDelimitedField(f.rawTag, childRes.bytes));
          continue;
        }
      }

      chunks.push(f.fullRaw);
    }

    return changed ? { changed: true, bytes: concatChunks(chunks) } : { changed: false, bytes: buf };
  }

  function filterGetWatchProtobuf(buf, depth, stats) {
    if (depth > 4 || buf.length < 16) return { changed: false, bytes: buf };
    var fields = decodeFields(buf);
    if (!fields) return { changed: false, bytes: buf };

    if (isPlayerResponseFields(fields)) {
      return filterPlayerProtobuf(buf, stats);
    }

    var chunks = [];
    var changed = false;

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.wireType !== 2 || f.payload.length < 16) {
        chunks.push(f.fullRaw);
        continue;
      }

      var subFields = decodeFields(f.payload);
      var subRes;
      if (subFields && isPlayerResponseFields(subFields)) {
        subRes = filterPlayerProtobuf(f.payload, stats);
      } else if (
        depth < 3 &&
        subFields &&
        (containsAsciiMarker(f.payload, "googlevideo.com/videoplayback") ||
          containsAsciiMarker(f.payload, "api/stats/watchtime") ||
          containsAsciiMarker(f.payload, "api/stats/playback"))
      ) {
        // PlayerResponse 位於更深一層容器時繼續往下定位
        subRes = filterGetWatchProtobuf(f.payload, depth + 1, stats);
      } else {
        // 推薦列／WatchNext 分支
        subRes = filterFeedProtobuf(f.payload, 1, false, stats);
      }

      if (subRes && subRes.changed) {
        changed = true;
        chunks.push(rebuildLengthDelimitedField(f.rawTag, subRes.bytes));
      } else {
        chunks.push(f.fullRaw);
      }
    }

    return changed ? { changed: true, bytes: concatChunks(chunks) } : { changed: false, bytes: buf };
  }

  // ---------------------------------------------------------------------------
  // JSON 備援過濾邏輯（相容非 Protobuf 客戶端或網頁介面）
  // ---------------------------------------------------------------------------

  function isJsonAdObject(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (JSON_AD_KEYS[keys[i]]) return true;
    }
    if (obj.elementRenderer) {
      try {
        var serialized = JSON.stringify(obj.elementRenderer).toLowerCase();
        for (var j = 0; j < FEED_AD_MARKERS.length; j++) {
          if (serialized.indexOf(FEED_AD_MARKERS[j]) !== -1) return true;
        }
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function stripJsonAds(node, stats) {
    if (!node || typeof node !== "object") return false;
    var changed = false;

    if (Array.isArray(node)) {
      for (var i = node.length - 1; i >= 0; i--) {
        if (isJsonAdObject(node[i])) {
          node.splice(i, 1);
          changed = true;
          stats.removedFeedItems++;
        } else if (stripJsonAds(node[i], stats)) {
          changed = true;
        }
      }
      return changed;
    }

    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (JSON_AD_KEYS[key]) {
        delete node[key];
        changed = true;
        stats.removedJsonKeys.push(key);
      } else if (stripJsonAds(node[key], stats)) {
        changed = true;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // 主流程
  // ---------------------------------------------------------------------------

  try {
    var endpoint = detectEndpoint(url);
    if (endpoint === "unknown") {
      $done({});
      return;
    }

    var stats = {
      seenPlayerFields: [],
      removedPlayerFields: [],
      removedFeedItems: 0,
      removedJsonKeys: []
    };

    var bodyBin = typeof $response.body !== "undefined" && $response.body !== null ? toUint8Array($response.body) : null;
    var bodyBytesBin = typeof $response.bodyBytes !== "undefined" && $response.bodyBytes !== null ? toUint8Array($response.bodyBytes) : null;

    var useBodyBytesOut = Boolean(bodyBytesBin && !bodyBin);
    var rawBytes = bodyBin || bodyBytesBin;
    var rawText = !rawBytes && typeof $response.body === "string" ? $response.body : null;

    // 路徑 A：文字 JSON 模式
    if (rawText !== null) {
      var trimmedText = rawText.trim();
      if (trimmedText.charAt(0) !== "{" && trimmedText.charAt(0) !== "[") {
        $done({});
        return;
      }
      var parsedText = JSON.parse(rawText);
      if (stripJsonAds(parsedText, stats)) {
        logDebug(
          "endpoint=" + endpoint + " mode=json-text removedKeys=" + stats.removedJsonKeys.join(",") + " removedItems=" + stats.removedFeedItems
        );
        $done({ body: JSON.stringify(parsedText) });
      } else {
        $done({});
      }
      return;
    }

    if (!rawBytes || rawBytes.length === 0) {
      $done({});
      return;
    }

    // 路徑 B：二進位緩衝區裡裝的是 JSON
    if (isLikelyJsonBytes(rawBytes)) {
      try {
        var jsonStr = bytesToUtf8(rawBytes);
        var parsedObj = JSON.parse(jsonStr);
        if (stripJsonAds(parsedObj, stats)) {
          var outJsonBytes = utf8ToBytes(JSON.stringify(parsedObj));
          logDebug(
            "endpoint=" + endpoint + " mode=json-bytes removedKeys=" + stats.removedJsonKeys.join(",") + " removedItems=" + stats.removedFeedItems
          );
          if (useBodyBytesOut) {
            $done({ bodyBytes: outJsonBytes.buffer });
          } else {
            $done({ body: outJsonBytes });
          }
          return;
        }
        $done({});
        return;
      } catch (jsonErr) {
        // 非合法 JSON，改走 Protobuf 處理
      }
    }

    // 路徑 C：Binary Protobuf 模式
    var protoRes;
    if (endpoint === "player") {
      protoRes = filterPlayerProtobuf(rawBytes, stats);
    } else if (endpoint === "get_watch") {
      protoRes = filterGetWatchProtobuf(rawBytes, 0, stats);
    } else {
      protoRes = filterFeedProtobuf(rawBytes, 0, endpoint === "reel", stats);
    }

    if (protoRes && protoRes.changed) {
      logDebug(
        "endpoint=" +
          endpoint +
          " mode=protobuf seen=[" +
          stats.seenPlayerFields.join(",") +
          "] removedPlayerFields=[" +
          stats.removedPlayerFields.join(",") +
          "] removedFeedItems=" +
          stats.removedFeedItems +
          " size=" +
          rawBytes.length +
          "->" +
          protoRes.bytes.length
      );
      if (useBodyBytesOut) {
        $done({ bodyBytes: protoRes.bytes.buffer });
      } else {
        $done({ body: protoRes.bytes });
      }
      return;
    }

    logDebug(
      "endpoint=" +
        endpoint +
        " mode=protobuf unchanged seen=[" +
        stats.seenPlayerFields.join(",") +
        "] size=" +
        rawBytes.length
    );
    $done({});
  } catch (err) {
    logDebug("error=" + (err && err.message ? err.message : String(err)));
    $done({});
  }
})();
