# Few-shot example: binary search

Input image: student wrote `[1, 3, 5, 7, 9, 11], find 7?`

Expected output:

```
[title: "Binary Search"]
[text: "Sorted list. Target is 7."]
[box: id=B0 label="1"]
[box: id=B1 label="3"]
[box: id=B2 label="5"]
[box: id=B3 label="7"]
[box: id=B4 label="9"]
[box: id=B5 label="11"]
[text: "Check the middle: index 2 holds 5."]
[arrow: from=B2 to=B2 label="mid"]
[text: "5 is less than 7. Search the right half."]
[text: "New middle: index 4 holds 9."]
[arrow: from=B4 to=B4 label="mid"]
[text: "9 is greater than 7. Look left. That leaves index 3."]
[text: "Index 3 holds 7. Found it."]
[equation: "T(n) = O(\\log n)"]
[text: "Each step halves the search range."]
```
