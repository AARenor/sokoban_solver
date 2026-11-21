// A push-optimal Sokoban solver for the levels this competition draws.
//
// Every drawn level is a one-square hallway across the board with the player on it, and one to four rooms off
// the hallway, each room holding its own boxes and as many goals. Pushes inside one room never touch another
// room, and only pushes are counted, so the board is split at the hallway and each room is solved on its own:
// a search over all boxes at once would have to carry up to sixteen boxes, a room carries three or four.
//
// A room's search is A* over push states. A state is the sorted box squares plus the square the player stood on
// after the last push; a move is one push, so the search's g is the number of pushes. Squares a box can never
// be pushed from to a goal are pruned before the search starts, boxes standing on one of them are refused, and
// the estimate is the least-cost assignment of boxes to goals under those push distances. The player's walking
// between pushes is not part of the state: at the end each push is replayed and the walk to the square behind
// the box is reconstructed as u, d, l and r moves.
//
// The work is bounded by `budget`, a shared count of expansions (`{ left }`), never by the clock, so the same
// level answered twice gives the same moves.

const WALL = 1, GOAL = 2, BOX = 4;
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const MOVE = ['u', 'd', 'l', 'r'];

/** The level from XSB text: cells, box and goal squares, and the player's square. */
function parse(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const h = lines.length;
  const w = Math.max(...lines.map((line) => line.length));
  const cells = new Uint8Array(w * h);
  const boxes = [];
  const goals = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const line = lines[y];
    for (let x = 0; x < w; x++) {
      const ch = line[x] ?? ' ';
      const i = y * w + x;
      if (ch === '#') {
        cells[i] = WALL;
        continue;
      }
      let v = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        v |= GOAL;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') {
        v |= BOX;
        boxes.push(i);
      }
      if (ch === '@' || ch === '+') player = i;
      cells[i] = v;
    }
  }
  return { w, h, cells, boxes, goals, player, n: w * h };
}

/** The free squares next to one square. */
function neighbours(level, i) {
  const { w, h, cells } = level;
  const x = i % w, y = (i - x) / w;
  const out = [];
  if (y > 0 && !(cells[i - w] & WALL)) out.push(i - w);
  if (y < h - 1 && !(cells[i + w] & WALL)) out.push(i + w);
  if (x > 0 && !(cells[i - 1] & WALL)) out.push(i - 1);
  if (x < w - 1 && !(cells[i + 1] & WALL)) out.push(i + 1);
  return out;
}

/** The free run through the player's start square: across the board when `across`, else up and down. */
function lineThrough(level, across) {
  const { w, h, cells, player } = level;
  const line = new Uint8Array(level.n);
  if (player < 0) return line;
  const px = player % w, py = (player - px) / w;
  const free = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !(cells[y * w + x] & WALL);
  if (across) {
    let x0 = px, x1 = px;
    while (free(x0 - 1, py)) x0--;
    while (free(x1 + 1, py)) x1++;
    for (let x = x0; x <= x1; x++) line[py * w + x] = 1;
  } else {
    let y0 = py, y1 = py;
    while (free(px, y0 - 1)) y0--;
    while (free(px, y1 + 1)) y1++;
    for (let y = y0; y <= y1; y++) line[y * w + px] = 1;
  }
  return line;
}

/**
 * The rooms a line leaves: one part per room, with the room's boxes and goals, and the squares a box may be
 * pushed on. Null when the line does not split the level cleanly: a box or goal on the line, or a room whose
 * boxes and goals do not pair.
 */
function decompose(level, line) {
  const room = new Int32Array(level.n).fill(-1);
  let next = 0;
  for (let s = 0; s < level.n; s++) {
    if (level.cells[s] & WALL || line[s] || room[s] !== -1) continue;
    const queue = [s];
    room[s] = next;
    for (let qi = 0; qi < queue.length; qi++) {
      for (const u of neighbours(level, queue[qi])) {
        if (room[u] !== -1 || line[u]) continue;
        room[u] = next;
        queue.push(u);
      }
    }
    next++;
  }
  for (const b of level.boxes) if (line[b] || room[b] < 0) return null;
  for (const g of level.goals) if (line[g] || room[g] < 0) return null;
  const inside = new Uint8Array(level.n);
  for (let i = 0; i < level.n; i++) if (room[i] >= 0) inside[i] = 1;
  const parts = [];
  for (let r = 0; r < next; r++) parts.push({ allowed: inside, boxes: [], goals: [] });
  for (const b of level.boxes) parts[room[b]].boxes.push(b);
  for (const g of level.goals) parts[room[g]].goals.push(g);
  const kept = [];
  for (const part of parts) {
    if (part.boxes.length === 0 && part.goals.length === 0) continue;
    if (part.boxes.length !== part.goals.length) return null;
    kept.push(part);
  }
  return kept.length === 0 ? null : kept;
}

/**
 * For each goal, the least pushes one box needs to arrive from every square, by a reverse push search.
 * A square with -1 is one no box can reach that goal from, inside the allowed region.
 */
function pushFields(level, allowed, goals) {
  const { w, h, cells, n } = level;
  return goals.map((goal) => {
    const dist = new Int16Array(n).fill(-1);
    const queue = [goal];
    dist[goal] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      const cx = cur % w, cy = (cur - cx) / w;
      for (let d = 0; d < 4; d++) {
        const fx = cx - DX[d], fy = cy - DY[d];
        const bx = fx - DX[d], by = fy - DY[d];
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
        if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
        const from = fy * w + fx;
        const behind = by * w + bx;
        if (!allowed[from]) continue;
        if (cells[from] & WALL || cells[behind] & WALL) continue;
        if (dist[from] >= 0) continue;
        dist[from] = dist[cur] + 1;
        queue.push(from);
      }
    }
    return dist;
  });
}

// The player-reachable region is stamped into reused buffers: a search may expand a million states, and an
// allocation per state would cost more than the search.
let regionBuf = null;
let regionGen = 0;
let regionStack = null;

/** Mark every square the player can walk to with the boxes where they are, and return the mark. */
function playerRegion(level, boxSet, start) {
  const n = level.n;
  if (!regionBuf || regionBuf.length !== n) {
    regionBuf = new Int32Array(n);
    regionGen = 0;
    regionStack = new Int32Array(n);
  }
  regionGen += 1;
  const mark = regionGen;
  const stack = regionStack;
  let sp = 0;
  stack[sp++] = start;
  regionBuf[start] = mark;
  const { w, h, cells } = level;
  while (sp > 0) {
    const cur = stack[--sp];
    const x = cur % w, y = (cur - x) / w;
    if (y > 0) { const u = cur - w; if (regionBuf[u] !== mark && !(cells[u] & WALL) && !boxSet.has(u)) { regionBuf[u] = mark; stack[sp++] = u; } }
    if (y < h - 1) { const u = cur + w; if (regionBuf[u] !== mark && !(cells[u] & WALL) && !boxSet.has(u)) { regionBuf[u] = mark; stack[sp++] = u; } }
    if (x > 0) { const u = cur - 1; if (regionBuf[u] !== mark && !(cells[u] & WALL) && !boxSet.has(u)) { regionBuf[u] = mark; stack[sp++] = u; } }
    if (x < w - 1) { const u = cur + 1; if (regionBuf[u] !== mark && !(cells[u] & WALL) && !boxSet.has(u)) { regionBuf[u] = mark; stack[sp++] = u; } }
  }
  return { mark, buf: regionBuf };
}

/** Least-cost assignment of `boxes` to `goals` by push distance (exact for four, Hungarian above). */
function assignCost(boxes, goals, fields) {
  const nb = boxes.length, ng = goals.length;
  if (nb === 0) return 0;
  if (nb !== ng) return 1e9;
  if (nb <= 4) {
    let best = 1e9;
    const used = new Array(nb).fill(false);
    const rec = (i, acc) => {
      if (acc >= best) return;
      if (i === nb) { best = acc; return; }
      for (let j = 0; j < nb; j++) {
        if (used[j]) continue;
        const d = fields[j][boxes[i]];
        if (d < 0) continue;
        used[j] = true;
        rec(i + 1, acc + d);
        used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  }
  const m = nb;
  const INF = 1e6;
  const a = boxes.map((b) => fields.map((f) => { const d = f[b]; return d < 0 ? INF : d; }));
  const u = new Array(m + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  let total = 0;
  for (let j = 1; j <= m; j++) total += a[p[j] - 1][j - 1];
  return total;
}

/** The push-optimal plan for one region and the expansions it cost, or a null plan when the budget ran out. */
function searchRegion(level, allowed, boxes0, goals, budget) {
  if (budget <= 0) return { plan: null, used: 0 };
  const { w, cells, n } = level;
  const fields = pushFields(level, allowed, goals);
  const dead = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (cells[i] & WALL || !allowed[i]) { dead[i] = 1; continue; }
    let ok = false;
    for (const f of fields) if (f[i] >= 0) { ok = true; break; }
    dead[i] = ok ? 0 : 1;
  }
  const goalSet = new Set(goals);
  for (const b of boxes0) if (dead[b] && !goalSet.has(b)) return { plan: null, used: 0 };
  const start = boxes0.slice().sort((a, b) => a - b);
  const h0 = assignCost(start, goals, fields);
  if (h0 > 1e8) return { plan: null, used: 0 };

  // States encode into numbers, never strings: one number when a region holds few boxes, two levels of map
  // when the whole board is searched, so a key stays exact (no 2^53 collisions).
  const base = level.n + 1;
  const split = boxes0.length > 6 ? 6 : boxes0.length;
  const enc = (boxes, pl, from) => {
    let k = from === 0 ? pl : 0;
    for (let i = from; i < Math.min(from + split, boxes.length); i++) k = k * base + boxes[i];
    return k;
  };
  const two = boxes0.length > 6;
  const seen1 = new Map();
  const seen2 = new Map();
  const getSeen = (boxes, pl) => {
    const k1 = enc(boxes, pl, 0);
    if (!two) return seen1.get(k1);
    const inner = seen2.get(k1);
    return inner ? inner.get(enc(boxes, 0, split)) : undefined;
  };
  const setSeen = (boxes, pl, g) => {
    const k1 = enc(boxes, pl, 0);
    if (!two) { seen1.set(k1, g); return; }
    let inner = seen2.get(k1);
    if (!inner) { inner = new Map(); seen2.set(k1, inner); }
    inner.set(enc(boxes, 0, split), g);
  };

  const buckets = new Map();
  let pending = 0;
  const put = (f, node) => {
    let b = buckets.get(f);
    if (!b) { b = []; buckets.set(f, b); }
    b.push(node);
    pending += 1;
  };
  put(h0, { boxes: start, player: level.player, g: 0, h: h0, parent: null, dir: 0, from: -1 });
  setSeen(start, level.player, 0);
  let fMin = h0;
  let expanded = 0;
  const boxSet = new Set();
  while (fMin <= 1e8) {
    const bucket = buckets.get(fMin);
    if (!bucket || bucket.length === 0) {
      buckets.delete(fMin);
      // No node left anywhere: the region is unsolvable, and there is no f value left to scan.
      if (pending === 0) return { plan: null, used: expanded };
      fMin++;
      continue;
    }
    const node = bucket.pop();
    pending -= 1;
    if (node.g + node.h !== fMin) continue;
    if (expanded >= budget) return { plan: null, used: expanded };
    expanded++;
    let done = true;
    for (const b of node.boxes) if (!goalSet.has(b)) { done = false; break; }
    if (done) {
      const plan = [];
      let cur = node;
      while (cur.parent) { plan.push({ from: cur.from, dir: cur.dir }); cur = cur.parent; }
      return { plan: plan.reverse(), used: expanded };
    }
    boxSet.clear();
    for (const b of node.boxes) boxSet.add(b);
    const region = playerRegion(level, boxSet, node.player);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const box = node.boxes[bi];
      for (let d = 0; d < 4; d++) {
        const to = box + DY[d] * w + DX[d];
        if (to < 0 || to >= n || !allowed[to]) continue;
        if (cells[to] & WALL || boxSet.has(to)) continue;
        if (dead[to] && !goalSet.has(to)) continue;
        // The player may stand anywhere free, inside the room or in the hallway outside it.
        const stand = box - DY[d] * w - DX[d];
        if (stand < 0 || stand >= n || cells[stand] & WALL || region.buf[stand] !== region.mark) continue;
        const nb = node.boxes.slice();
        nb[bi] = to;
        nb.sort((a, b) => a - b);
        const g = node.g + 1;
        const prev = getSeen(nb, box);
        if (prev !== undefined && prev <= g) continue;
        setSeen(nb, box, g);
        const hh = assignCost(nb, goals, fields);
        if (hh > 1e8) continue;
        put(g + hh, { boxes: nb, player: box, g, h: hh, parent: node, dir: d, from: box });
      }
    }
  }
  return { plan: null, used: expanded };
}

/** The walking moves from `from` to `to` without stepping on a live box, or null when there is no way. */
function walkPath(level, liveBoxes, from, to) {
  if (from === to) return '';
  const { w, h, cells, n } = level;
  const prev = new Int32Array(n).fill(-2);
  const via = new Uint8Array(n);
  const queue = [from];
  prev[from] = -1;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const cx = cur % w, cy = (cur - cx) / w;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -2 || cells[ni] & WALL || liveBoxes.has(ni)) continue;
      prev[ni] = cur;
      via[ni] = d;
      if (ni === to) {
        let out = '';
        let c = ni;
        while (prev[c] !== -1) { out = MOVE[via[c]] + out; c = prev[c]; }
        return out;
      }
      queue.push(ni);
    }
  }
  return null;
}

/** Replay the push plan on the level and fill the walking between pushes in as LURD moves. */
function render(level, plan) {
  const live = new Set(level.boxes);
  let player = level.player;
  let moves = '';
  let pushes = 0;
  for (const step of plan) {
    const stand = step.from - DY[step.dir] * level.w - DX[step.dir];
    const path = walkPath(level, live, player, stand);
    if (path === null) return null;
    moves += path + MOVE[step.dir];
    live.delete(step.from);
    live.add(step.from + DY[step.dir] * level.w + DX[step.dir]);
    player = step.from;
    pushes++;
  }
  return { moves, pushes };
}

/**
 * The level's answer: `{ moves, pushes }`, or null when the budget ran out before a room was solved.
 * `budget` is `{ left }`: expansions shared by the whole set, never the clock.
 */
export function solve(text, budget = { left: 400_000 }) {
  const level = parse(text);
  if (level.boxes.length === 0) return { moves: '', pushes: 0 };
  // Split the board at the hallway. The drawn hallway runs across the board, but a line is only used when it
  // leaves rooms whose boxes and goals pair; of two such lines, the one with the fewest boxes in a room wins.
  // A level the split cannot describe is searched over the whole board.
  let parts = null;
  let best = Infinity;
  for (const line of [lineThrough(level, true), lineThrough(level, false)]) {
    const candidate = decompose(level, line);
    if (candidate === null) continue;
    let most = 0;
    for (const p of candidate) if (p.boxes.length > most) most = p.boxes.length;
    if (parts === null || most < best) { parts = candidate; best = most; }
  }
  if (parts === null) {
    const allFree = new Uint8Array(level.n);
    for (let i = 0; i < level.n; i++) if (!(level.cells[i] & WALL)) allFree[i] = 1;
    parts = [{ allowed: allFree, boxes: level.boxes, goals: level.goals }];
  }

  // Each room, in order, with a growing grant; a room that fails its first grant is tried again with more.
  const plan = [];
  for (const part of parts) {
    let sub = null;
    for (const share of [100_000, 500_000, 1_500_000]) {
      const grant = Math.min(share, budget.left);
      if (grant <= 0) break;
      const outcome = searchRegion(level, part.allowed, part.boxes, part.goals, grant);
      budget.left -= outcome.used;
      if (outcome.plan !== null) { sub = outcome.plan; break; }
    }
    if (!sub) return null;
    for (const step of sub) plan.push(step);
  }
  return render(level, plan);
}

/** The name the entrypoint calls; kept beside `solve` for the harness's step-2 naming. */
export const run = solve;
