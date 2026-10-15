// @screenshot skip
// This example uses the sample plate drawing linked from the guide.
// Save it as images/plate-drawing.png beside this file before opening it.
import { image, sketch } from 'fluidcad/core';

const pictureWidth = 100; // Full picture width, including its margins, in document units.

// Choosing the XY plane opens a sketch viewed from above.
sketch('xy', () => {
    // Apply saves the picture's placement inside this sketch.
    // Only width is supplied, so height follows the image's pixel aspect ratio.
    image('images/plate-drawing.png', {
        width: pictureWidth,
        at: [0, 0],   // Centre of the picture in sketch coordinates.
        angle: 0,     // Counter-clockwise rotation in degrees.
        opacity: 0.5, // 50% opacity keeps the picture behind the lines you draw.
    });
});
