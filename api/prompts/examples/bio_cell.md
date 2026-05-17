# Few-shot example: animal cell (biology)

Input image: student wrote `Label the parts of an animal cell?`

Expected output. The cell is decomposed into 4 parts so each organelle is named and drawn separately:

```
[title: "Animal Cell"]
[text: "The cell is bounded by a membrane and filled with cytoplasm."]
[text: "Start with the cell membrane."]
[draw_part: name="cell membrane" viewBox="0 0 400 300"]
<ellipse cx="200" cy="150" rx="180" ry="110"/>
[/draw_part]
[text: "The nucleus stores DNA and directs cell activity."]
[draw_part: name="nucleus" viewBox="0 0 400 300"]
<circle cx="180" cy="150" r="42"/>
<text x="156" y="155" font-family="Virgil" font-size="13">Nucleus</text>
[/draw_part]
[text: "Mitochondria generate ATP, the cell's energy currency."]
[draw_part: name="mitochondria" viewBox="0 0 400 300"]
<ellipse cx="90" cy="110" rx="28" ry="12"/>
<text x="60" y="90" font-family="Virgil" font-size="11">Mitochondrion</text>
<ellipse cx="280" cy="100" rx="24" ry="10"/>
<text x="252" y="82" font-family="Virgil" font-size="11">Mitochondrion</text>
[/draw_part]
[text: "Ribosomes synthesize proteins from mRNA."]
[draw_part: name="ribosomes" viewBox="0 0 400 300"]
<circle cx="280" cy="200" r="6"/>
<text x="245" y="225" font-family="Virgil" font-size="11">Ribosome</text>
<circle cx="110" cy="210" r="6"/>
<text x="78" y="235" font-family="Virgil" font-size="11">Ribosome</text>
[/draw_part]
[text: "All organelles float in the cytoplasm and work together."]
```
