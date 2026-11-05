/* 个性化推荐算法核心（纯函数，浏览器和 Node 共用）
 *
 * 思路参照短视频/视频站的推荐流程：
 *   行为信号 → 兴趣画像（带时间衰减） → 多路召回 → 打分排序 → 打散 + 探索 → 推荐理由
 *
 * - 影片特征：类型 g:、地区 r:、主创 p:、片种 t:、年代 d:，例如 ['g:科幻', 'r:欧美', 'p:诺兰', 't:movie', 'd:2010s']
 * - 行为信号：打开详情、开始播放、观看时长（越接近看完权重越高）、点「喜欢」、点「不感兴趣」
 * - 兴趣画像：每部影片的行为权重按 21 天半衰期衰减后，累加到它的各个特征上
 * - 召回：候选池（热门/分类/榜单，按画像匹配） + 相关影片（豆瓣「看过这部的人也喜欢」，即物品协同过滤）
 * - 排序：兴趣匹配 + 相关召回 + 豆瓣评分 + 热度新鲜度 + 少量随机扰动，曝光未点击会逐次降权
 * - 打散：相邻影片尽量不同类型/地区，避免同质化；固定位置插入画像以外的高分影片做探索
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DAY = 86400000;
  var HALF_LIFE = 21 * DAY;
  // 各类特征在匹配时的权重：类型最能代表口味，主创次之，片种和年代只做微调
  var FAMILY_WEIGHT = { g: 1, p: 0.9, r: 0.6, t: 0.35, d: 0.25 };
  var FAMILY_NAME = { g: '类型', p: '主创', r: '地区', t: '片种', d: '年代' };
  var TYPE_NAME = { movie: '电影', tv: '剧集', show: '综艺' };

  var REGION = {
    华语: ['中国大陆', '中国香港', '中国台湾', '中国', '中国澳门'],
    欧美: ['美国', '英国', '法国', '德国', '意大利', '西班牙', '加拿大', '澳大利亚', '爱尔兰', '新西兰', '瑞典', '丹麦',
      '挪威', '芬兰', '荷兰', '比利时', '瑞士', '奥地利', '波兰', '俄罗斯', '苏联', '捷克', '匈牙利', '葡萄牙', '希腊',
      '冰岛', '墨西哥', '巴西', '阿根廷', '西德', '捷克斯洛伐克', '卢森堡'],
    日本: ['日本'],
    韩国: ['韩国'],
  };
  var REGION_OF = {};
  Object.keys(REGION).forEach(function (bucket) {
    REGION[bucket].forEach(function (c) { REGION_OF[c] = bucket; });
  });

  // 站内分类标签对应的特征：列表项本身没有类型/地区字段，从所在分类推断
  var TAG_FEATURES = {
    movie: {
      华语: ['r:华语'], 欧美: ['r:欧美'], 韩国: ['r:韩国'], 日本: ['r:日本'],
      动作: ['g:动作'], 喜剧: ['g:喜剧'], 爱情: ['g:爱情'], 科幻: ['g:科幻'], 悬疑: ['g:悬疑'], 恐怖: ['g:恐怖'], 文艺: ['g:剧情'],
    },
    tv: {
      美剧: ['r:欧美'], 英剧: ['r:欧美'], 韩剧: ['r:韩国'], 日剧: ['r:日本'], 国产剧: ['r:华语'], 港剧: ['r:华语'],
      日本动画: ['g:动画', 'r:日本'], 综艺: ['g:真人秀'], 纪录片: ['g:纪录片'],
    },
  };

  // 冷启动时让用户挑选的类型
  var STARTER_GENRES = ['喜剧', '动作', '爱情', '科幻', '悬疑', '犯罪', '恐怖', '动画', '奇幻', '剧情', '战争', '历史', '纪录片', '真人秀'];

  function uniq(list) {
    var seen = {};
    return list.filter(function (x) {
      if (!x || seen[x]) return false;
      seen[x] = true;
      return true;
    });
  }

  function regionOf(country) {
    country = String(country || '').trim();
    return REGION_OF[country] || country;
  }

  function decadeOf(year) {
    var y = parseInt(year, 10);
    if (!(y > 1900 && y < 2100)) return '';
    return Math.floor(y / 10) * 10 + 's';
  }

  // meta: { type, genres, countries, people, year }，genres/countries/people 可为数组或空格、逗号分隔的字符串
  function featuresOf(meta) {
    meta = meta || {};
    function list(v) {
      if (Array.isArray(v)) return v;
      return String(v || '').split(/[\s,/]+/);
    }
    var f = [];
    list(meta.genres).forEach(function (g) { if (g) f.push('g:' + g.trim()); });
    list(meta.countries).forEach(function (c) { if (c) f.push('r:' + regionOf(c)); });
    list(meta.people).slice(0, 4).forEach(function (p) { if (p) f.push('p:' + p.trim()); });
    if (meta.type) f.push('t:' + meta.type);
    var d = decadeOf(meta.year);
    if (d) f.push('d:' + d);
    return uniq(f);
  }

  function familyOf(key) { return key.slice(0, key.indexOf(':')); }
  function nameOf(key) { return key.slice(key.indexOf(':') + 1); }

  function decay(age) { return Math.pow(0.5, Math.max(0, age) / HALF_LIFE); }

  // 一部影片上的行为汇总成一个权重：完整看下来的影片比只点开看看重要得多
  function itemWeight(rec) {
    if (!rec) return 0;
    if (rec.dislike) return -6;
    var w = 0;
    if (rec.view) w += 1 + Math.min(2, (rec.view - 1) * 0.5);
    if (rec.play) w += 2;
    if (rec.watch) w += 4 * Math.min(1, rec.watch / 1200); // 观看满 20 分钟记满分
    if (rec.like) w += 5;
    return w;
  }

  // state: { items: { id: { f, view, play, watch, like, dislike, t, title } }, seeds: ['科幻', ...] }
  function buildProfile(state, now) {
    now = now || Date.now();
    state = state || {};
    var raw = {};
    var strength = 0;
    var items = state.items || {};
    Object.keys(items).forEach(function (id) {
      var rec = items[id];
      var w = itemWeight(rec) * decay(now - (rec.t || now));
      if (!w) return;
      if (w > 0) strength += w;
      // 不感兴趣只削弱一半，避免一次误点就把整个类型封掉
      var k = w < 0 ? w * 0.5 : w;
      (rec.f || []).forEach(function (f) { raw[f] = (raw[f] || 0) + k; });
    });
    (state.seeds || []).forEach(function (g) {
      raw['g:' + g] = (raw['g:' + g] || 0) + 3;
      strength += 3;
    });
    var max = 0;
    Object.keys(raw).forEach(function (f) { if (raw[f] > max) max = raw[f]; });
    var weights = {};
    Object.keys(raw).forEach(function (f) {
      weights[f] = max ? Math.max(-1, raw[f] / max) : 0;
    });
    return {
      weights: weights,
      strength: strength,
      // 画像置信度：行为越多，个性化分量越重；新用户主要看评分和热度
      confidence: Math.min(1, strength / 12),
    };
  }

  // 画像里最突出的兴趣，用于「我的口味」展示
  function topInterests(profile, n) {
    var w = profile.weights;
    return Object.keys(w)
      .filter(function (f) { return w[f] > 0.15 && familyOf(f) !== 't'; })
      .sort(function (a, b) { return w[b] - w[a]; })
      .slice(0, n || 12)
      .map(function (f) {
        var fam = familyOf(f);
        var name = nameOf(f);
        return { key: f, family: fam, familyName: FAMILY_NAME[fam], name: fam === 'd' ? name.replace('s', '年代') : name, weight: w[f] };
      });
  }

  // 兴趣匹配度：影片特征和画像的加权内积，再按特征数开方归一，避免特征多的影片天然占优
  function interestOf(item, profile) {
    var w = profile.weights;
    var sum = 0, norm = 0, best = null, bestVal = 0;
    (item.f || []).forEach(function (f) {
      var fw = FAMILY_WEIGHT[familyOf(f)] || 0.3;
      norm += fw;
      var v = w[f] || 0;
      if (!v) return;
      var c = fw * v;
      sum += c;
      if (familyOf(f) !== 't' && c > bestVal) { bestVal = c; best = f; }
    });
    return { value: norm ? sum / Math.sqrt(norm) : 0, top: best };
  }

  function qualityOf(item) {
    var r = Number(item.rate);
    if (!r) return 0.35;
    return Math.max(0, Math.min(1, (r - 6) / 3.5));
  }

  function freshOf(item) {
    return (item.hot ? 0.6 : 0) + (item.isNew ? 0.4 : 0);
  }

  // 可复现的伪随机数，同一次「换一批」内结果稳定
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function similarity(a, b) {
    var fa = a.f || [], fb = b.f || [];
    var set = {}, inter = 0, union = 0;
    fa.forEach(function (f) { if (familyOf(f) === 'g' || familyOf(f) === 'r') { set[f] = 1; union++; } });
    fb.forEach(function (f) {
      if (familyOf(f) !== 'g' && familyOf(f) !== 'r') return;
      if (set[f]) inter++;
      else union++;
    });
    var s = union ? inter / union : 0;
    if (a.via && b.via && a.via.id === b.via.id) s += 0.3;
    return s;
  }

  function primaryGenre(item) {
    var f = item.f || [];
    for (var i = 0; i < f.length; i++) if (familyOf(f[i]) === 'g') return f[i];
    return '';
  }

  function reasonText(item, parts, profile) {
    if (item.explore) return '探索新口味';
    if (parts.related > 0.12 && item.via) return (item.via.liked ? '因为你喜欢《' : '因为你看过《') + item.via.title + '》';
    if (parts.interest > 0.18 && parts.top) {
      var fam = familyOf(parts.top), name = nameOf(parts.top);
      if (fam === 'g') return '你常看' + name;
      if (fam === 'p') return '你关注的' + name;
      if (fam === 'r') return name + '影视偏好';
      if (fam === 'd') return '偏爱' + name.replace('s', '年代');
    }
    if (Number(item.rate) >= 8.5) return '豆瓣高分 ' + item.rate;
    if (item.isNew) return '新片上线';
    if (item.hot) return item.type === 'movie' ? '近期热门' : '正在热播';
    if (Number(item.rate) >= 7.5) return '口碑佳作';
    return TYPE_NAME[item.type] ? '热门' + TYPE_NAME[item.type] : '为你精选';
  }

  /*
   * 生成推荐列表
   * pool: 候选影片 [{ id, title, cover, rate, year, type, f, hot, isNew }]
   * related: 相关召回 [{ via: { id, title, weight, liked }, items: [...] }]
   * state: 行为数据（见 buildProfile），state.imp = { id: [曝光次数, 时间] }
   * opts: { seed, now, exclude: { id: true }, limit, exploreEvery }
   */
  function recommend(pool, related, state, opts) {
    opts = opts || {};
    state = state || {};
    var now = opts.now || Date.now();
    var random = rng(opts.seed || 1);
    var profile = buildProfile(state, now);
    var conf = profile.confidence;
    var items = state.items || {};
    var imp = state.imp || {};
    var exclude = opts.exclude || {};

    // 召回：合并候选池和相关影片，同一部影片保留最强的相关来源
    var byId = {};
    function add(item, via, rank) {
      var id = String(item.id);
      if (!id || exclude[id]) return;
      var seen = items[id];
      if (seen && (seen.dislike || seen.view || seen.play)) return; // 看过的和不感兴趣的不再推
      var cur = byId[id];
      if (!cur) cur = byId[id] = Object.assign({}, item, { id: id, f: item.f || [], rel: 0 });
      else if ((!cur.f || !cur.f.length) && item.f && item.f.length) cur.f = item.f;
      if (via) {
        // 相关度：来源影片的行为权重 × 在相关列表里的名次
        var rel = Math.min(1, via.weight / 8) * (1 - Math.min(rank, 15) / 20);
        if (rel > cur.rel) { cur.rel = rel; cur.via = via; }
      }
    }
    (related || []).forEach(function (group) {
      (group.items || []).forEach(function (item, i) { add(item, group.via, i); });
    });
    (pool || []).forEach(function (item) { add(item, null, 0); });

    var topGenres = topInterests(profile, 40).filter(function (x) { return x.family === 'g'; }).slice(0, 4)
      .map(function (x) { return x.key; });

    var scored = Object.keys(byId).map(function (id) {
      var item = byId[id];
      var it = interestOf(item, profile);
      var q = qualityOf(item);
      var fresh = freshOf(item);
      var score = conf * (0.65 * it.value + 0.5 * item.rel) +
        0.28 * q + 0.22 * fresh * (1 - 0.6 * conf) + 0.06 * random();
      // 曝光过但没点开的，每次曝光降权 18%，「刷到不想看的」会逐渐沉下去
      var shown = imp[id] ? imp[id][0] : 0;
      if (shown) score *= Math.pow(0.82, Math.min(shown, 6));
      item.score = score;
      item.parts = { interest: it.value, top: it.top, related: item.rel, quality: q };
      return item;
    });
    scored.sort(function (a, b) { return b.score - a.score; });

    // 探索候选：评分不错、类型既不在已有兴趣里、也没被标记过不感兴趣的影片
    var explore = [];
    if (conf > 0.25) {
      explore = scored.filter(function (item) {
        if (item.parts.quality < 0.55 || item.rel) return false;
        return !(item.f || []).some(function (f) {
          if (familyOf(f) !== 'g') return false;
          var v = profile.weights[f] || 0;
          return v > 0.1 || v < -0.05 || topGenres.indexOf(f) >= 0;
        });
      });
      for (var i = explore.length - 1; i > 0; i--) {
        var j = Math.floor(random() * (i + 1));
        var tmp = explore[i]; explore[i] = explore[j]; explore[j] = tmp;
      }
    }
    var exploreIds = {};
    explore.forEach(function (x) { exploreIds[x.id] = true; });

    // 打散（MMR）：每次在前 40 名里挑「分数 - 与最近几部的相似度」最高的
    var limit = opts.limit || 300;
    var remaining = scored.filter(function (x) { return !exploreIds[x.id]; }).slice(0, limit + 40);
    var picked = [];
    var every = opts.exploreEvery || 7;
    var lambda = 0.3;
    while (picked.length < limit && (remaining.length || explore.length)) {
      if (explore.length && (picked.length % every === every - 2 || !remaining.length)) {
        var e = explore.shift();
        e.explore = true;
        picked.push(e);
        continue;
      }
      if (!remaining.length) break;
      var recent = picked.slice(-4);
      var bestIdx = 0, bestVal = -Infinity;
      for (var k = 0; k < Math.min(40, remaining.length); k++) {
        var c = remaining[k];
        var pen = 0;
        recent.forEach(function (p, idx) {
          pen = Math.max(pen, similarity(c, p) * (idx === recent.length - 1 ? 1 : 0.7));
        });
        // 硬性打散：同一主类型最多连续 2 部；电影、剧集最多连续 3 部
        var g = primaryGenre(c);
        var genreRun = g && recent.length >= 2 && recent.slice(-2).every(function (p) { return primaryGenre(p) === g; });
        var typeRun = recent.length >= 3 && recent.slice(-3).every(function (p) { return p.type === c.type; });
        // 同一部影片带来的相关推荐，最近 6 部里最多 2 部，避免一部片刷屏
        var viaRun = c.via && picked.slice(-6).filter(function (p) { return p.via && p.via.id === c.via.id; }).length >= 2;
        var val = c.score - lambda * pen - (genreRun ? 0.5 : 0) - (typeRun ? 0.15 : 0) - (viaRun ? 0.4 : 0);
        if (val > bestVal) { bestVal = val; bestIdx = k; }
      }
      picked.push(remaining.splice(bestIdx, 1)[0]);
    }

    return picked.map(function (item) {
      return {
        id: item.id, title: item.title, cover: item.cover, rate: item.rate, year: item.year, type: item.type,
        reason: reasonText(item, item.parts, profile), explore: !!item.explore, via: item.via ? item.via.id : '',
        score: Math.round(item.score * 1000) / 1000,
      };
    });
  }

  // 内容相似：没有协同过滤数据时（静态版）用类型、地区、主创的重合度找相关影片
  function similar(target, pool, n) {
    var tf = {};
    (target.f || []).forEach(function (f) { tf[f] = FAMILY_WEIGHT[familyOf(f)] || 0.3; });
    var tnorm = Object.keys(tf).reduce(function (s, f) { return s + tf[f] * tf[f]; }, 0);
    return (pool || [])
      .filter(function (item) { return String(item.id) !== String(target.id); })
      .map(function (item) {
        var dot = 0, norm = 0;
        (item.f || []).forEach(function (f) {
          var w = FAMILY_WEIGHT[familyOf(f)] || 0.3;
          norm += w * w;
          if (tf[f]) dot += w * tf[f];
        });
        var cos = norm && tnorm ? dot / Math.sqrt(norm * tnorm) : 0;
        return { item: item, s: cos * 0.85 + qualityOf(item) * 0.15 };
      })
      .filter(function (x) { return x.s > 0.2; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, n || 12)
      .map(function (x) { return x.item; });
  }

  // 用于召回相关影片的「种子」：近期行为权重最高的几部
  function seedItems(state, n, now) {
    now = now || Date.now();
    var items = (state && state.items) || {};
    return Object.keys(items)
      .map(function (id) {
        var rec = items[id];
        return { id: id, title: rec.title, liked: !!rec.like, weight: itemWeight(rec) * decay(now - (rec.t || now)) };
      })
      .filter(function (x) { return x.weight > 0.5 && /^\d+$/.test(x.id); })
      .sort(function (a, b) { return b.weight - a.weight; })
      .slice(0, n || 4);
  }

  return {
    TAG_FEATURES: TAG_FEATURES,
    STARTER_GENRES: STARTER_GENRES,
    TYPE_NAME: TYPE_NAME,
    featuresOf: featuresOf,
    regionOf: regionOf,
    itemWeight: itemWeight,
    buildProfile: buildProfile,
    topInterests: topInterests,
    recommend: recommend,
    similar: similar,
    seedItems: seedItems,
  };
});
