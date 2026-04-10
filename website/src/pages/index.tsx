import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import HeroSection from '@site/src/components/landing/HeroSection';
import CodeShowcase from '@site/src/components/landing/CodeShowcase';
import FeatureGrid from '@site/src/components/landing/FeatureGrid';
import ShowcaseSection from '@site/src/components/landing/ShowcaseSection';
import EditorSection from '@site/src/components/landing/EditorSection';

export default function Home(): ReactNode {
  return (
    <Layout
      title="Parametric CAD for everyone"
      description="FluidCAD — write CAD models in JavaScript. See the result in real time.">
      <main>
        <HeroSection />
        <CodeShowcase />
        <ShowcaseSection />
        <FeatureGrid />
<EditorSection />
      </main>
    </Layout>
  );
}
