# Few-shot example: vector addition

Input image: student drew vector `u` going right and vector `v` going up-right, with `u + v = ?`

Expected output:

```
[title: "Vector Addition"]
[text: "Place u and v tip to tail."]
[node: id=O label="O"]
[node: id=A label="u-tip"]
[node: id=B label="u+v"]
[arrow: from=O to=A label="u"]
[arrow: from=A to=B label="v"]
[arrow: from=O to=B label="u+v"]
[text: "The resultant runs from O to the final tip."]
[equation: "(u + v)_x = u_x + v_x"]
[equation: "(u + v)_y = u_y + v_y"]
[text: "Add the components separately."]
```
