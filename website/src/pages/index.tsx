import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import Hero from '@site/src/landing/hero/Hero';
import Exchange from '@site/src/landing/exchange/Exchange';
import Assembly from '@site/src/landing/assembly/Assembly';
import Mcp from '@site/src/landing/mcp/Mcp';
import Get from '@site/src/landing/get/Get';
import Gallery from '@site/src/landing/gallery/Gallery';
import Close from '@site/src/landing/close/Close';

export default function Home(): ReactNode {
  return (
    <Layout
      title="Hybrid CAD"
      description="FluidCAD is hybrid CAD: model with the mouse, control it with code. Parametric modeling on the OpenCascade B-Rep kernel, with a feature tree, assemblies, a sketch constraint solver and STEP interop.">
      <main>
        <Hero />
        <Exchange />
        <Assembly />
        <Get />
        <Mcp />
        <Gallery />
        <Close />
      </main>
    </Layout>
  );
}
