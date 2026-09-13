import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import Hero from '@site/src/landing/hero/Hero';
import Exchange from '@site/src/landing/exchange/Exchange';
import Kernel from '@site/src/landing/kernel/Kernel';
import Assembly from '@site/src/landing/assembly/Assembly';
import Hosts from '@site/src/landing/hosts/Hosts';
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
        <Kernel />
        <Assembly />
        <Hosts />
        <Get />
        <Gallery />
        <Close />
      </main>
    </Layout>
  );
}
