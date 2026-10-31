# chromagraph

Created to visualise data with motion, specifically for projecting environmental or social issues.


It runs in the browser and renders everything with [Three.js](https://threejs.org) on WebGL2. That covers lines, boxes, heat maps, density clouds and the camera flying through them. Under the hood it's TypeScript and [Vite](https://vite.dev), with a small Node server (Fastify) keeping the project files and keeping the control window and the output in step. D3 does the maths, Papa Parse reads the CSVs, troika-three-text draws the type, Tweakpane builds the controls.

The code lives at [github.com/edmonkey-nz/chromagraph](https://github.com/edmonkey-nz/chromagraph). It's made in Aotearoa New Zealand, free to use under the MIT licence. 