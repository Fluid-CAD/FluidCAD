Design a website for my opensource project. The project is a CAD system for creating CAD models using javascript. The project name is FluidCAD.

The home page should convey the main features of the project:
- Easy to learn and memorize syntax
- Workflow similar to traditional CAD software, but with the flexibility of coding
- Live preview of the design as you code
- Interactive UI helpers for some tasks that are easier to do with mouse interaction. (gif will be provided)
- Navigate through the design history easity with the history timeline (gif will be provided)
- Provide visual guidance to remove the thinking overhead during the design process
- Feature transformation: apply transformation to features of the whole model.
- Import STEP files with color support.
- Support for exporting models in various formats (e.g., STEP, STL, OBJ)



We want to show examples of the features described above.

``` javascript
sketch("xy", () => {
  circle(10);
  circle(40);
});

extrude(50)
```

``` javascript
sketch("xy", () => {
    radius(100, 50).radius(15)
});

const e = extrude(50)

sketch(e.endFaces(), () => {
    circle(20)
});

cut()

```



