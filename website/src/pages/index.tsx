import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import HeroSection from '@site/src/components/landing/HeroSection';
import CodeShowcase from '@site/src/components/landing/CodeShowcase';
import FeatureGrid from '@site/src/components/landing/FeatureGrid';
import WorkflowSection from '@site/src/components/landing/WorkflowSection';
import EditorSection from '@site/src/components/landing/EditorSection';
import GetStartedSection from '@site/src/components/landing/GetStartedSection';

export default function Home(): ReactNode {
  return (
    <Layout
      title="Parametric CAD for everyone"
      description="FluidCAD — write CAD models in JavaScript. See the result in real time.">
      <main>
        <HeroSection />
        <CodeShowcase />
        <FeatureGrid />
        <WorkflowSection />
        <EditorSection />
        <GetStartedSection />
      </main>
    </Layout>
  );
}
