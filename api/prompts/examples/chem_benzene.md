# Few-shot example: benzene structure (chemistry)

Input image: student wrote `Draw the structure of benzene? C6H6`.

Expected output. The benzene structure is decomposed into 3 parts so the student sees the carbon skeleton emerge first, then the delocalised pi cloud, then the carbon labels:

```
[title: "Benzene"]
[text: "Six carbons in a planar ring with delocalised pi electrons."]
[text: "First the carbon hexagon."]
[draw_part: name="carbon hexagon" viewBox="0 0 400 360"]
M 200 40 L 320 110 L 320 250 L 200 320 L 80 250 L 80 110 Z
[/draw_part]
[text: "Now the delocalised pi cloud (the ring of electrons)."]
[draw_part: name="pi electron ring" viewBox="0 0 400 360"]
<circle cx="200" cy="180" r="60"/>
[/draw_part]
[text: "Label each carbon."]
[draw_part: name="carbon labels" viewBox="0 0 400 360"]
<text x="192" y="30" font-family="Virgil" font-size="16">C</text>
<text x="328" y="115" font-family="Virgil" font-size="16">C</text>
<text x="328" y="265" font-family="Virgil" font-size="16">C</text>
<text x="192" y="340" font-family="Virgil" font-size="16">C</text>
<text x="52" y="265" font-family="Virgil" font-size="16">C</text>
<text x="52" y="115" font-family="Virgil" font-size="16">C</text>
[/draw_part]
[equation: "C_6 H_6"]
[text: "Each carbon also bonds to one hydrogen, omitted for clarity."]
[text: "All C-C bonds are equal length: 1.39 angstrom."]
[text: "The aromatic ring is planar and unusually stable."]
```
