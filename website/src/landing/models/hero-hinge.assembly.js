import { connector, extrude, insert, mate, part, plane, rect, select, shell, sketch } from "fluidcad/core";
import { edge } from "fluidcad/filters";

function boxBody() {
    return part("Case", () => {
        sketch("top", () => {
            rect(100, 60).centered().radius(15);
        });

        const body = extrude(30);

        shell(-2, body.endFaces());

        connector("hinge", select(edge().onPlane("top", 30).onPlane("front", -30).line()));
    });
}

function boxLid() {
    return part("Lid", () => {
        sketch(plane("top", 30), () => {
            rect(100, 60).centered().radius(15);
        });

        const lid = extrude(10).new();

        shell(-2, lid.startFaces());

        connector("hinge", select(edge().onPlane("top", 30).onPlane("front", -30).line()));
    });
}

const body = insert(boxBody()).grounded();
const lid = insert(boxLid()).rotate("x", -55);

mate("revolute", body.connectors.hinge, lid.connectors.hinge).limits(0, 180);
