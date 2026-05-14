# Few-shot example: vector addition

Input image: student drew vector u going right and vector v going up-right, with `sum = ?`

Expected output:

```
[title: "Vector Addition"]
[text: "You drew two vectors u and v and want their sum."]
[text: "Place them tip to tail: start v where u ended."]
[node: id=O label="O"]
[node: id=A label="u-tip"]
[node: id=B label="u+v"]
[arrow: from=O to=A label="u"]
[arrow: from=A to=B label="v"]
[arrow: from=O to=B label="u+v"]
[text: "The resultant arrow from the origin to the final tip is u plus v."]
[equation: "(u + v)_x = u_x + v_x"]
[equation: "(u + v)_y = u_y + v_y"]
[text: "Add the components separately, and that's your answer."]
```
