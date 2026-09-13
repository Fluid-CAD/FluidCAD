import { connector, extrude, insert, line, mate, part, plane, select, sketch } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

function square(size) {
    const half = size / 2;
    const bottom = line([-half, -half], [half, -half]);
    const right = line([half, -half], [half, half]);
    const top = line([half, half], [-half, half]);
    const left = line([-half, half], [-half, -half]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-half, -half]);
    distance(bottom.start(), bottom.end(), size);
    distance(right.start(), right.end(), size);
}

function base() {
    return part("Base", () => {
        sketch("top", () => {
            square(60);
        });

        extrude(20);

        connector("hinge", select(edge().onPlane("top", 20).onPlane("front", -30).line()));
    });
}

function flap() {
    return part("Flap", () => {
        sketch(plane("top", 20), () => {
            square(60);
        });

        extrude(10).new();

        connector("hinge", select(edge().onPlane("top", 20).onPlane("front", -30).line()));
    });
}

const block = insert(base()).grounded();
const lid = insert(flap());

mate("revolute", block.connectors.hinge, lid.connectors.hinge).rotate(65).limits(0, 180);
