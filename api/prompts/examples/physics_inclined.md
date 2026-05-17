# Few-shot example: block on inclined plane (physics)

Input image: student wrote `block on a 30 deg incline, mass 5 kg, find acceleration?`.

Expected output. The free-body diagram is decomposed into 4 named parts so each force vector appears as the teacher names it:

```
[title: "Block on an Incline"]
[text: "A block slides down a 30 deg frictionless incline."]
[text: "Start with the incline."]
[draw_part: name="incline" viewBox="0 0 400 300"]
M 40 250 L 360 250 L 40 90 Z
[/draw_part]
[text: "Now place the block."]
[draw_part: name="block on the incline" viewBox="0 0 400 300"]
M 150 130 L 210 130 L 230 165 L 170 165 Z
[/draw_part]
[text: "Add the weight vector pulling straight down."]
[draw_part: name="weight (mg)" viewBox="0 0 400 300"]
M 195 145 L 195 230
M 190 222 L 195 232 L 200 222
<text x="200" y="225" font-family="Virgil" font-size="13">mg</text>
[/draw_part]
[text: "And the normal force perpendicular to the surface."]
[draw_part: name="normal force (N)" viewBox="0 0 400 300"]
M 195 145 L 240 113
M 232 109 L 242 113 L 236 121
<text x="245" y="115" font-family="Virgil" font-size="13">N</text>
<text x="55" y="245" font-family="Virgil" font-size="13">30 deg</text>
[/draw_part]
[equation: "F_{net} = m g \\sin\\theta"]
[equation: "a = g \\sin\\theta"]
[equation: "a = 9.8 \\cdot \\sin 30^\\circ"]
[equation: "a = 9.8 \\cdot 0.5 = 4.9 \\, m/s^2"]
[text: "The block accelerates down the slope at 4.9 meters per second squared."]
```
