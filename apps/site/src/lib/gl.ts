/** Just enough WebGL to run a full-screen fragment shader. GLSL ES 1.00, so WebGL1 or WebGL2 will do. */

export type GL = WebGLRenderingContext | WebGL2RenderingContext;

const FULLSCREEN_VERT = /* glsl */ `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export function getGL(canvas: HTMLCanvasElement, attrs: WebGLContextAttributes = {}): GL | null {
  const options: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    ...attrs,
  };
  try {
    return canvas.getContext('webgl2', options) ?? canvas.getContext('webgl', options);
  } catch {
    return null;
  }
}

function compile(gl: GL, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[tandem/site] shader failed to compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export interface Quad<U extends string> {
  program: WebGLProgram;
  uniforms: Record<U, WebGLUniformLocation | null>;
  draw(): void;
  dispose(): void;
}

/** Compile `frag` against the shared full-screen vertex shader and look up the named uniforms. */
export function createQuad<U extends string>(
  gl: GL,
  frag: string,
  uniformNames: readonly U[],
): Quad<U> | null {
  const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[tandem/site] program failed to link:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  // One oversized triangle covers the viewport without a diagonal seam.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const uniforms = {} as Record<U, WebGLUniformLocation | null>;
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);

  return {
    program,
    uniforms,
    draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

/** Release a context we no longer need; browsers cap how many can be alive at once. */
export function loseContext(gl: GL): void {
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}
