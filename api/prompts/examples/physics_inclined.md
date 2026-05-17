# Few-shot example: block on inclined plane (physics)

Input image: student wrote `block on a 30 deg incline, mass 5 kg, find acceleration?`.

Expected output (uses `[draw]` for the free-body diagram with multiple labelled force arrows):

```
[title: "Block on an Incline"]
[text: "A block slides down a 30 deg frictionless incline."]
[draw: svg="<g stroke='#111' fill='none' stroke-width='2'><path d='M 40 250 L 360 250 L 40 90 Z'/><rect x='150' y='130' width='60' height='40' transform='rotate(-30 180 150)' fill='#fef3c7'/><line x1='180' y1='150' x2='180' y2='220' stroke-width='2.5'/><polygon points='176,218 184,218 180,228' fill='#111'/><text x='185' y='220' font-family='Virgil' font-size='13'>mg</text><line x1='180' y1='150' x2='220' y2='128' stroke-width='2.5'/><polygon points='216,124 224,128 218,135' fill='#111'/><text x='225' y='124' font-family='Virgil' font-size='13'>N</text><text x='55' y='245' font-family='Virgil' font-size='13'>30 deg</text></g>" viewBox="0 0 400 300" caption="Free-body diagram: gravity mg and normal force N"]
[equation: "F_{net} = m g \\sin\\theta"]
[equation: "a = g \\sin\\theta"]
[equation: "a = 9.8 \\cdot \\sin 30^\\circ"]
[equation: "a = 9.8 \\cdot 0.5 = 4.9 \\, m/s^2"]
[text: "The block accelerates down the slope at 4.9 meters per second squared."]
```
