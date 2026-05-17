# Few-shot example: Pythagorean theorem (mathematics)

Input image: student wrote `right triangle, legs 3 and 4, hypotenuse = ?`.

Expected output. The model decomposes the diagram into 3 named parts (triangle, right-angle marker, side labels) so the student watches it build up exactly as a human teacher would draw it on a whiteboard:

```
[title: "Pythagorean Theorem"]
[text: "In a right triangle, the legs and hypotenuse satisfy a fixed relation."]
[text: "First the triangle itself."]
[draw_part: name="right triangle" viewBox="0 0 400 300"]
M 60 240 L 60 80 L 300 240 Z
[/draw_part]
[text: "Mark the right angle."]
[draw_part: name="right-angle marker" viewBox="0 0 400 300"]
M 60 215 L 85 215 L 85 240
[/draw_part]
[text: "Label the sides."]
[draw_part: name="side labels" viewBox="0 0 400 300"]
<text x="30" y="165" font-family="Virgil" font-size="16">a = 3</text>
<text x="160" y="270" font-family="Virgil" font-size="16">b = 4</text>
<text x="160" y="150" font-family="Virgil" font-size="16">c = ?</text>
[/draw_part]
[equation: "a^2 + b^2 = c^2"]
[equation: "3^2 + 4^2 = c^2"]
[equation: "9 + 16 = c^2"]
[equation: "c^2 = 25"]
[equation: "c = 5"]
[text: "The hypotenuse is 5 units."]
```
