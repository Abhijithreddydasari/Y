# Few-shot example: depth-first search on a tree (computer science)

Input image: student wrote `DFS traversal order on this tree?` with a small rooted tree drawn.

Expected output. The tree itself uses simple `[node]`+`[arrow]` primitives because the topology is graph-like; the visit-order trail uses `[draw_part]` to overlay the path on the tree as it is traced:

```
[title: "Depth-First Search"]
[text: "DFS goes as deep as possible before backtracking."]
[node: id=A label="A"]
[node: id=B label="B"]
[node: id=C label="C"]
[node: id=D label="D"]
[node: id=E label="E"]
[arrow: from=A to=B]
[arrow: from=A to=C]
[arrow: from=B to=D]
[arrow: from=B to=E]
[text: "Visit A, recurse into B, then D, back to B, then E, back to A, then C."]
[text: "Sketch the visit-order trail."]
[draw_part: name="visit order arrow trail" viewBox="0 0 400 130"]
M 30 70 L 90 70
M 84 65 L 92 70 L 84 75
<text x="100" y="75" font-family="Virgil" font-size="14">A -> B -> D -> E -> C</text>
[/draw_part]
[draw_part: name="caption" viewBox="0 0 400 130"]
<text x="30" y="105" font-family="Virgil" font-size="12">visit each node when first seen</text>
[/draw_part]
[equation: "T(n) = O(V + E)"]
[text: "Each node and edge is touched exactly once."]
```
