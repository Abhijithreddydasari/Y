# Few-shot example: Pythagorean theorem (mathematics)

Input image: student wrote `right triangle, legs 3 and 4, hypotenuse = ?`.

Expected output (mixes simple primitives with a `[draw]` of the labelled triangle):

```
[title: "Pythagorean Theorem"]
[text: "In a right triangle, the legs and hypotenuse satisfy a fixed relation."]
[draw: svg="<g stroke='#111' fill='none' stroke-width='2'><path d='M 60 240 L 60 80 L 300 240 Z'/><path d='M 60 215 L 85 215 L 85 240' stroke-width='1.5'/><text x='30' y='165' font-family='Virgil' font-size='16'>a = 3</text><text x='160' y='270' font-family='Virgil' font-size='16'>b = 4</text><text x='160' y='150' font-family='Virgil' font-size='16'>c = ?</text></g>" viewBox="0 0 400 300" caption="Right triangle with legs a, b and hypotenuse c"]
[equation: "a^2 + b^2 = c^2"]
[equation: "3^2 + 4^2 = c^2"]
[equation: "9 + 16 = c^2"]
[equation: "c^2 = 25"]
[equation: "c = 5"]
[text: "The hypotenuse is 5 units."]
```
