# The published FluidCAD image; its entrypoint already binds 0.0.0.0:3100 with
# /app/projects as the projects folder. Auth is the Worker's basic auth, so the
# start screen runs without its own sign-in link, answering only the public URL.
FROM ghcr.io/fluid-cad/fluidcad:0.0.47
ENV FLUIDCAD_NO_AUTH=1
