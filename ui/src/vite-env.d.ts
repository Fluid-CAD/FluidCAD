declare module '*.svg?raw' {
  const content: string;
  export default content;
}

/** Vite compiles a `?worker` import into a Worker constructor. */
declare module '*?worker' {
  const workerConstructor: new (options?: { name?: string }) => Worker;
  export default workerConstructor;
}

/** Monaco reads its worker factory off the global. */
interface Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}
