# Push-optimal Sokoban solver

`main.ts` answers every instance of a make.fun Sokoban set: for each `/input/<id>/level.txt` it writes
`/output/<id>/solution.txt`, the player's moves in LURD that put every box on a goal in as few pushes as the level
allows.

## Level format

XSB, one row a line: `#` wall, a space floor, `.` goal, `$` box, `*` box on a goal, `@` player, `+` player on a goal.
The drawn levels are a one-square hallway across the board with one to four rooms off it; each room holds its own
three or four boxes and as many goals.

## Answer format

A sequence of `u`, `d`, `l`, `r` (either case, whitespace ignored). One letter is one step; a step that moves a box is a
push. The checker replays the moves: a step into a wall, or a push of a box into a wall or another box, is illegal and
scores 0. A replay that ends with every box on a goal solves the level: 1,000 points when it takes P* pushes, and
500 x P* / pushes otherwise. One push over the optimum halves that instance's points, so the search minimises pushes,
not moves.

## How the search works

The board is split at the hallway (the free line through the player's start square) into rooms. A push in one room never
touches another room, and walking between rooms is free, so each room is solved on its own: A* over push states, where a
state is the sorted box squares plus the square the player stood on after the last push. The split is checked before it is
used: the free run across the player's row is tried first, then the run up and down the player's column, and a line is
kept only when every room it leaves holds as many boxes as goals and no box or goal sits on the line. Of two lines that
pass, the one with the fewest boxes in a room wins; a level neither line describes is searched over the whole board.
Before the search, a reverse push search from each goal marks every square a box can be pushed to that goal from; a box on
a square that reaches no goal is dead, and a push onto such a square is pruned. The estimate is the least-cost assignment
of boxes to goals under those push distances, exact for up to four boxes and the Hungarian method above. After the pushes
are found, the walk to the square behind each box is reconstructed with a breadth-first search that treats the boxes as
walls, and the whole answer is written as LURD.

The work is capped by one `{ left }` expansion budget shared by the whole set (2,000,000 in `main.ts`), never by the
clock, so two executions do the same work and write the same bytes.

## How to run it

```
mkdir -p out
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22.18 or later. No dependencies: `main.ts` is plain JavaScript with a `.ts` name, and `solve.js` is an ES module.
The input default is `/input` and the output default is `/output`.

## Measured

- Practice set: score 1,000,000, all five instances push-optimal (13, 16, 29, 47 and 60 pushes against P* 13, 16, 29,
  47 and 60), about 0.08 s for the set.
- Eight fresh sets drawn from random seeds (40 instances, including four-room, sixteen-box levels): 1,000,000 on every
  one, every instance at P*, each set answered in 0.08 s to 0.14 s.
- Determinism: the practice set run twice into two directories gave five byte-identical `solution.txt` files on `cmp`.
- A level with an immobile box gets a valid empty answer and the run still exits 0, so one hard instance cannot cost the
  others their files.
