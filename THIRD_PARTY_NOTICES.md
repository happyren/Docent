# Third-party notices

Docent is built on the work of others. This file carries the licenses and
attributions for the third-party software and assets that Docent depends on
and ships (D26). It accompanies the source repository and every distributed
artifact — self-host images and desktop installers alike.

Docent itself is MIT-licensed (see [LICENSE](LICENSE)). Docent is an
independent project: it is **not affiliated with, endorsed by, or sponsored
by** any of the projects or companies named below.

---

## Excalidraw

Docent is inspired by and built upon [Excalidraw](https://github.com/excalidraw/excalidraw) —
the open-source virtual whiteboard. Docent embeds Excalidraw as a pinned,
unmodified npm dependency (`@excalidraw/excalidraw`); the drawing canvas,
its rendering, and its file format are Excalidraw's work, and Docent's
constitution forbids ever forking or patching it (invariant I1). Without
Excalidraw, Docent would not exist.

> MIT License
>
> Copyright (c) 2020 Excalidraw
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
> 
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
> 
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## React and React DOM

[React](https://react.dev) (`react`, `react-dom`), MIT License,
Copyright (c) Meta Platforms, Inc. and affiliates.

## Bundled shape libraries

Shipped verbatim under `public/libraries/`, both published through
[excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries)
(MIT License, Copyright (c) 2020 Excalidraw):

- **Software Architecture** — by [Youri Tjang](https://github.com/youritjang), 7 items.
- **AWS Architecture Icons** — by [Anna Pastushko](https://github.com/ChildishGirl), 249 items.
  AWS, the AWS logo, and AWS service names are trademarks of Amazon.com, Inc.
  or its affiliates. The MIT license above covers redistribution of the
  drawings; the marks remain Amazon's. Docent and this library are not
  affiliated with or endorsed by Amazon Web Services.

## Transitive dependencies

Excalidraw and React bring their own dependencies (for example
[Rough.js](https://roughjs.com), MIT, which draws the hand-sketched strokes).
Their licenses ship inside the respective packages and are preserved
unmodified in every Docent distribution.
