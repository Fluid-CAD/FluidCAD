import {part12, part1,p2, p1 } from './base.fluid.js';
import {mate, insert } from 'fluidcad/core';

const p11 = insert(p1).grounded()

const p21 = insert(p2).translate(32.33895, 45.221703, -19.58196);

mate('slider', p21.connectors.c1, p11.connectors.c1);

const part11 = insert(part1).translate(59.221497, 0, 0);

mate('revolute', part11.connectors.c1, p11.connectors.c2).flip();

const part121 = insert(part12).translate(113.122966, 0, 0);

mate('revolute', part121.connectors.c1, p11.connectors.c3).flip();
mate('tangent', part11.features.g1, part121.features.g3);
mate('tangent', part121.features.g4, p21.features.g1);

