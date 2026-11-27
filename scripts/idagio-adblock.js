/**
 * IDAGIO Safe JSON Promo Filter & Scrubbed Diagnostic Helper for Shadowrocket
 *
 * 設計原則：
 * 1. 僅處理 api.idagio.com 的合法 JSON 回應，絕不觸碰音訊串流與非 JSON 資料。
 * 2. 僅剔除陣列中明確標記為廣告／推銷／插播型別的物件，不誤刪正常古典樂曲目、錄音或作品。
 * 3. 不修改會員訂閱欄位或帳號權限。
 * 4. 內建去敏診斷模式（argument=debug=true）：僅記錄請求純路徑（不含 Query 參數）與
 *    JSON 結構鍵名／型別欄位，不輸出任何 Token、Cookie、Email 或個人資訊，
 *    協助確認 IDAGIO 免費版第一方推銷語音的實際欄位名稱。
 */

(function () {
  "use strict";

  if (typeof $response === "undefined" || !$response || typeof $response.body !== "string") {
    $done({});
    return;
  }

  var url = typeof $request !== "undefined" && $request && $request.url ? String($request.url) : "";
  var args = parseArguments(typeof $argument !== "undefined" ? $argument : "");
  var DEBUG = Boolean(args.debug);

  var PROMO_TYPE_SET = {
    ad: true,
    ads: true,
    audio_ad: true,
    "audio-ad": true,
    audioad: true,
    advertisement: true,
    promo: true,
    promotion: true,
    promotional: true,
    upsell: true,
    interstitial: true,
    commercial: true,
    sponsor: true,
    sponsored: true,
    house_ad: true,
    "house-ad": true,
    announcement: true
  };

  var PROMO_ARRAY_KEYS = {
    ads: true,
    audioAds: true,
    audio_ads: true,
    promos: true,
    promotions: true,
    interstitials: true,
    announcements: true
  };

  var TYPE_FIELDS = ["type", "kind", "itemType", "item_type", "contentType", "content_type", "category"];

  function parseArguments(raw) {
    var result = { debug: false };
    if (!raw || typeof raw !== "string") return result;
    var trimmed = raw.trim();
    if (!trimmed) return result;
    if (trimmed.charAt(0) === "{") {
      try {
        var obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object") {
          result.debug = obj.debug === true || obj.debug === "true" || obj.debug === 1;
        }
        return result;
      } catch (e) {
        // 回退為 key=value
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

  function getHeader(headers, nameLower) {
    if (!headers || typeof headers !== "object") return "";
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === nameLower) {
        return String(headers[keys[i]]);
      }
    }
    return "";
  }

  function getScrubbedPath(rawUrl) {
    var noQuery = rawUrl.split("?")[0].split("#")[0];
    var m = noQuery.match(/^https?:\/\/[^/]+(\/.*)?$/i);
    return m && m[1] ? m[1] : noQuery;
  }

  function isExplicitPromoObject(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;

    if (
      item.isAd === true ||
      item.is_ad === true ||
      item.isPromo === true ||
      item.is_promo === true ||
      item.isAdvertisement === true ||
      item.is_advertisement === true ||
      item.isSponsored === true ||
      item.is_sponsored === true
    ) {
      return true;
    }

    for (var i = 0; i < TYPE_FIELDS.length; i++) {
      var val = item[TYPE_FIELDS[i]];
      if (typeof val === "string") {
        var norm = val.trim().toLowerCase();
        if (PROMO_TYPE_SET[norm]) return true;
      }
    }

    return false;
  }

  function filterNode(node, stats) {
    if (!node || typeof node !== "object") return false;
    var changed = false;

    if (Array.isArray(node)) {
      for (var i = node.length - 1; i >= 0; i--) {
        if (isExplicitPromoObject(node[i])) {
          node.splice(i, 1);
          changed = true;
          stats.removedItems++;
        } else if (filterNode(node[i], stats)) {
          changed = true;
        }
      }
      return changed;
    }

    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var val = node[key];
      if (PROMO_ARRAY_KEYS[key] && Array.isArray(val) && val.length > 0) {
        stats.clearedArrays.push(key + "(" + val.length + ")");
        node[key] = [];
        changed = true;
      } else if (filterNode(val, stats)) {
        changed = true;
      }
    }
    return changed;
  }

  // 僅產生結構鍵名與型別摘要（絕不輸出使用者值、Token 或個資）
  function summarizeStructure(data) {
    if (!data || typeof data !== "object") return typeof data;
    if (Array.isArray(data)) {
      var sampleTypes = [];
      for (var i = 0; i < data.length && i < 5; i++) {
        sampleTypes.push(describeItemType(data[i]));
      }
      return "Array(" + data.length + ")[" + sampleTypes.join(",") + "]";
    }
    var keys = Object.keys(data).slice(0, 12);
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      var v = data[k];
      if (Array.isArray(v)) {
        var t = v.length > 0 ? describeItemType(v[0]) : "empty";
        parts.push(k + ":Array(" + v.length + "," + t + ")");
      } else if (v && typeof v === "object") {
        parts.push(k + ":Object(" + Object.keys(v).slice(0, 6).join("|") + ")");
      } else {
        parts.push(k + ":" + typeof v);
      }
    }
    return "{" + parts.join(", ") + "}";
  }

  function describeItemType(item) {
    if (!item || typeof item !== "object") return typeof item;
    for (var i = 0; i < TYPE_FIELDS.length; i++) {
      var f = TYPE_FIELDS[i];
      if (typeof item[f] === "string" && item[f].length <= 32) {
        return f + "=" + item[f];
      }
    }
    return "keys:" + Object.keys(item).slice(0, 5).join("|");
  }

  function logDebug(msg) {
    if (DEBUG && typeof console !== "undefined" && console.log) {
      console.log("[idagio-adblock] " + msg);
    }
  }

  try {
    var contentType = getHeader($response.headers, "content-type").toLowerCase();
    var body = $response.body;
    var trimmed = body.trim();
    var looksJson = trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[";

    if (contentType && contentType.indexOf("json") === -1 && !looksJson) {
      $done({});
      return;
    }
    if (!looksJson) {
      $done({});
      return;
    }

    var parsed = JSON.parse(body);
    var pathOnly = getScrubbedPath(url);
    var stats = { removedItems: 0, clearedArrays: [] };
    var changed = filterNode(parsed, stats);

    if (DEBUG) {
      logDebug(
        "path=" +
          pathOnly +
          " changed=" +
          changed +
          " removed=" +
          stats.removedItems +
          " cleared=[" +
          stats.clearedArrays.join(",") +
          "] shape=" +
          summarizeStructure(parsed)
      );
    }

    if (changed) {
      $done({ body: JSON.stringify(parsed) });
    } else {
      $done({});
    }
  } catch (err) {
    logDebug("error=" + (err && err.message ? err.message : String(err)));
    $done({});
  }
})();
