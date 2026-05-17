# Few-shot example: animal cell (biology)

Input image: student wrote `Label the parts of an animal cell?`

Expected output (uses `[draw]` for the cell with labelled organelles):

```
[title: "Animal Cell"]
[text: "The cell is bounded by a membrane and filled with cytoplasm."]
[draw: svg="<g stroke='#111' fill='none' stroke-width='2'><ellipse cx='200' cy='150' rx='180' ry='110'/><circle cx='180' cy='150' r='42' fill='#fef3c7'/><text x='162' y='155' font-family='Virgil' font-size='13'>Nucleus</text><ellipse cx='90' cy='110' rx='28' ry='12' fill='#dbeafe'/><text x='62' y='90' font-family='Virgil' font-size='11'>Mitochondrion</text><ellipse cx='280' cy='100' rx='24' ry='10' fill='#dbeafe'/><text x='258' y='82' font-family='Virgil' font-size='11'>Mitochondrion</text><circle cx='280' cy='200' r='8' fill='#fce7f3'/><text x='250' y='225' font-family='Virgil' font-size='11'>Ribosome</text><circle cx='110' cy='210' r='8' fill='#fce7f3'/><text x='80' y='235' font-family='Virgil' font-size='11'>Ribosome</text><path d='M 220 175 Q 250 175 250 195 Q 250 215 220 215 Q 250 215 250 235' stroke-width='1.5'/><text x='250' y='245' font-family='Virgil' font-size='11'>Golgi</text></g>" viewBox="0 0 400 300" caption="Animal cell with major organelles"]
[text: "The nucleus stores DNA and directs cell activity."]
[text: "Mitochondria generate ATP, the cell's energy currency."]
[text: "Ribosomes synthesize proteins from mRNA."]
[text: "The Golgi apparatus packages and ships those proteins."]
```
