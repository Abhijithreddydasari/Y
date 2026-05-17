# Few-shot example: benzene structure (chemistry)

Input image: student wrote `Draw the structure of benzene? C6H6`.

Expected output (uses `[draw]` for the ring):

```
[title: "Benzene"]
[text: "Six carbons in a planar ring with delocalised pi electrons."]
[draw: svg="<g stroke='#111' fill='none' stroke-width='2'><polygon points='200,40 320,110 320,250 200,320 80,250 80,110'/><circle cx='200' cy='180' r='60'/><text x='192' y='30' font-family='Virgil' font-size='16'>C</text><text x='328' y='115' font-family='Virgil' font-size='16'>C</text><text x='328' y='265' font-family='Virgil' font-size='16'>C</text><text x='192' y='340' font-family='Virgil' font-size='16'>C</text><text x='52' y='265' font-family='Virgil' font-size='16'>C</text><text x='52' y='115' font-family='Virgil' font-size='16'>C</text></g>" viewBox="0 0 400 360" caption="Benzene ring (the inner circle = 6 delocalised electrons)"]
[equation: "C_6 H_6"]
[text: "Each carbon bonds to one hydrogen, omitted for clarity."]
[text: "All C-C bonds are equal length: 1.39 angstrom."]
[text: "The aromatic ring is planar and unusually stable."]
```
