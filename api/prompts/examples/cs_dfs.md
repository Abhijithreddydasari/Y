# Few-shot example: depth-first search on a tree (computer science)

Input image: student wrote `DFS traversal order on this tree?` with a small rooted tree drawn.

Expected output (uses `[node]`+`[arrow]` for the tree and `[draw]` for the call stack illustration):

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
[draw: svg="<g stroke='#111' fill='none' stroke-width='2'><rect x='100' y='30' width='200' height='40'/><text x='130' y='55' font-family='Virgil' font-size='14'>A -> B -> D -> E -> C</text><text x='110' y='100' font-family='Virgil' font-size='12'>visit each node when first seen</text></g>" viewBox="0 0 400 130" caption="DFS visit order"]
[equation: "T(n) = O(V + E)"]
[text: "Each node and edge is touched exactly once."]
```
