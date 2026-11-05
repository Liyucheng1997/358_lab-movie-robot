const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/rec-core');
const { buildPool, parseRelated } = require('../src/recommend');

const DAY = 86400000;
const now = Date.UTC(2026, 10, 5);

function movie(id, genres, countries = ['美国'], rate = 8, extra = {}) {
  return { id: String(id), title: `影片${id}`, rate, type: 'movie', f: core.featuresOf({ type: 'movie', genres, countries, year: 2015 }), ...extra };
}

test('特征提取：类型、地区归并、主创、片种和年代', () => {
  const f = core.featuresOf({ type: 'movie', genres: ['科幻', '动作'], countries: ['美国', '英国', '中国香港'], people: ['诺兰', 'A', 'B', 'C', 'D'], year: '2010' });
  assert.deepEqual(f, ['g:科幻', 'g:动作', 'r:欧美', 'r:华语', 'p:诺兰', 'p:A', 'p:B', 'p:C', 't:movie', 'd:2010s']);
});

test('行为权重：看得越久、点喜欢越重要，不感兴趣为负', () => {
  const view = core.itemWeight({ view: 1 });
  const watched = core.itemWeight({ view: 1, play: 1, watch: 1800 });
  assert.ok(watched > view * 3);
  assert.ok(core.itemWeight({ view: 1, like: 1 }) > view);
  assert.ok(core.itemWeight({ view: 1, dislike: 1 }) < 0);
});

test('兴趣画像按时间衰减：近期行为比两个月前的更重要', () => {
  const state = { items: {
    1: { f: ['g:科幻'], view: 1, play: 1, watch: 1200, t: now - 1 * DAY },
    2: { f: ['g:爱情'], view: 1, play: 1, watch: 1200, t: now - 60 * DAY },
  } };
  const p = core.buildProfile(state, now);
  assert.equal(p.weights['g:科幻'], 1);
  assert.ok(p.weights['g:爱情'] < 0.25);
});

test('有观看记录时，同类型影片排在前面并给出推荐理由', () => {
  const pool = [
    movie(10, ['爱情'], ['法国'], 8.8), movie(11, ['科幻'], ['美国'], 7.6), movie(12, ['科幻', '悬疑'], ['美国'], 7.9),
    movie(13, ['喜剧'], ['中国大陆'], 8.0), movie(14, ['纪录片'], ['英国'], 9.0),
  ];
  const state = { items: {
    1: { f: core.featuresOf({ type: 'movie', genres: ['科幻'], countries: ['美国'] }), view: 1, play: 1, watch: 3000, like: 1, t: now },
    2: { f: core.featuresOf({ type: 'movie', genres: ['科幻', '悬疑'], countries: ['美国'] }), view: 1, play: 1, watch: 2400, t: now },
  } };
  const list = core.recommend(pool, [], state, { now, seed: 7, exploreEvery: 100 });
  assert.ok(['11', '12'].includes(list[0].id));
  assert.match(list[0].reason, /科幻|悬疑|欧美/);
});

test('看过的、不感兴趣的不再推荐；不感兴趣会压低同类影片', () => {
  const pool = [movie(1, ['恐怖']), movie(2, ['恐怖'], ['美国'], 8.5), movie(3, ['喜剧'], ['美国'], 7.5), movie(4, ['剧情'])];
  const state = { items: {
    1: { f: pool[0].f, dislike: 1, t: now },
    4: { f: pool[3].f, view: 1, t: now },
    9: { f: core.featuresOf({ type: 'movie', genres: ['喜剧'] }), view: 1, play: 1, watch: 600, t: now },
  } };
  const ids = core.recommend(pool, [], state, { now, seed: 3 }).map((x) => x.id);
  assert.ok(!ids.includes('1'));
  assert.ok(!ids.includes('4'));
  assert.ok(ids.indexOf('3') < ids.indexOf('2'));
});

test('相关召回：「因为你看过」的影片优先，并标注来源', () => {
  const pool = Array.from({ length: 20 }, (_, i) => movie(100 + i, ['剧情'], ['美国'], 8.5));
  const state = { items: { 5: { f: core.featuresOf({ type: 'movie', genres: ['犯罪'] }), title: '教父', view: 2, play: 1, watch: 3600, t: now } } };
  const related = [{ via: { id: '5', title: '教父', weight: 8 }, items: [movie(200, ['犯罪'], ['美国'], 8.0)] }];
  const list = core.recommend(pool, related, state, { now, seed: 1 });
  assert.equal(list[0].id, '200');
  assert.equal(list[0].reason, '因为你看过《教父》');
});

test('曝光多次没点开的影片逐渐下沉', () => {
  const pool = [movie(1, ['剧情'], ['美国'], 9.0), movie(2, ['剧情'], ['美国'], 8.6)];
  const fresh = core.recommend(pool, [], {}, { now, seed: 1 });
  assert.equal(fresh[0].id, '1');
  const tired = core.recommend(pool, [], { imp: { 1: [4, now] } }, { now, seed: 1 });
  assert.equal(tired[0].id, '2');
});

test('打散：相邻推荐尽量不是同一类型', () => {
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push(movie(i, ['科幻'], ['美国'], 8.6 - i * 0.01));
  for (let i = 10; i < 20; i++) pool.push(movie(i, ['喜剧'], ['日本'], 8.0 - i * 0.01));
  const state = { items: { 99: { f: core.featuresOf({ type: 'movie', genres: ['科幻'], countries: ['美国'] }), view: 1, play: 1, watch: 3000, t: now } } };
  const list = core.recommend(pool, [], state, { now, seed: 2, limit: 8 });
  const genreOf = (id) => (Number(id) < 10 ? '科幻' : '喜剧');
  let runs = 0;
  for (let i = 1; i < list.length; i++) if (genreOf(list[i].id) === genreOf(list[i - 1].id)) runs++;
  assert.ok(runs <= 3, `相邻同类型 ${runs} 次`);
});

test('探索：画像成形后插入兴趣以外的高分影片', () => {
  const pool = [];
  for (let i = 0; i < 20; i++) pool.push(movie(i, ['科幻'], ['美国'], 7.5));
  pool.push(movie(50, ['纪录片'], ['英国'], 9.2));
  const items = {};
  for (let i = 0; i < 4; i++) items[90 + i] = { f: core.featuresOf({ type: 'movie', genres: ['科幻'], countries: ['美国'] }), view: 1, play: 1, watch: 2400, t: now };
  const list = core.recommend(pool, [], { items }, { now, seed: 5 });
  const e = list.find((x) => x.explore);
  assert.equal(e && e.id, '50');
  assert.equal(e.reason, '探索新口味');
});

test('冷启动：选择的类型作为种子兴趣', () => {
  const pool = [movie(1, ['爱情'], ['美国'], 8.4), movie(2, ['动画'], ['日本'], 8.0)];
  const list = core.recommend(pool, [], { seeds: ['动画'] }, { now, seed: 1 });
  assert.equal(list[0].id, '2');
});

test('内容相似：按类型地区主创找相关影片', () => {
  const target = { id: '1', f: core.featuresOf({ type: 'movie', genres: ['动画', '奇幻'], countries: ['日本'], people: ['宫崎骏'] }) };
  const pool = [
    { id: '2', rate: 8.5, f: core.featuresOf({ type: 'movie', genres: ['动画', '奇幻'], countries: ['日本'], people: ['宫崎骏'] }) },
    { id: '3', rate: 9.0, f: core.featuresOf({ type: 'movie', genres: ['犯罪'], countries: ['美国'] }) },
  ];
  assert.deepEqual(core.similar(target, pool).map((x) => x.id), ['2']);
});

test('候选池：分类标签推断特征，详情覆盖为完整特征', () => {
  const pool = buildPool({
    lists: [{ type: 'movie', tag: '科幻', items: [{ id: '1', title: 'A', rate: '8.1', cover: 'c1' }] },
      { type: 'tv', tag: '日本动画', items: [{ id: '2', title: 'B', rate: '9.0', cover: 'c2', isNew: true }] }],
    boards: [{ id: 'movie_top250', items: [{ id: '3', title: 'C', rate: 9.7, year: '1994', region: '美国', genres: '剧情 犯罪', people: '导演,演员' }] }],
    details: { 1: { id: '1', title: 'A', isTv: false, genres: ['科幻', '冒险'], countries: ['美国'], directors: ['D'], actors: ['X', 'Y'], year: '2014' } },
  }, (u) => `/img/${u}`);
  const byId = Object.fromEntries(pool.map((x) => [x.id, x]));
  assert.deepEqual(byId[1].f, ['g:科幻', 'g:冒险', 'r:欧美', 'p:D', 'p:X', 'p:Y', 't:movie', 'd:2010s']);
  assert.deepEqual(byId[2].f, ['g:动画', 'r:日本', 't:tv']);
  assert.equal(byId[2].isNew, true);
  assert.ok(byId[3].f.includes('g:犯罪') && byId[3].f.includes('d:1990s'));
  assert.equal(byId[1].cover, '/img/c1');
});

test('解析豆瓣相关推荐', () => {
  const [m] = parseRelated([{ id: '1306249', title: '唐伯虎点秋香', type: 'movie', card_subtitle: '1993 / 中国香港 / 喜剧 爱情 古装 / 李力持 / 周星驰 巩俐', rating: { value: 8.8 }, pic: { large: 'L' } }]);
  assert.deepEqual(m.f, ['g:喜剧', 'g:爱情', 'g:古装', 'r:华语', 'p:李力持', 'p:周星驰', 'p:巩俐', 't:movie', 'd:1990s']);
  assert.equal(m.rate, 8.8);
});
