/**
 * Thin WebGL2 helpers: program wrappers with typed uniform setters, a render-target pool, and the
 * full-screen triangle every pass draws.
 *
 * Orientation convention: textures store row 0 at the TOP of the picture (we never flip on upload),
 * and full-screen passes map v_uv.y = 0 to clip-space y = -1. Internal buffers are therefore
 * "upside-down" by GL's reckoning but self-consistent, and `readPixels` returns rows top-first.
 * Only the final blit to the canvas flips.
 */

export type UniformValue = number | boolean | readonly number[] | Float32Array | WebGLTexture | null | undefined;

interface UniformInfo {
  loc: WebGLUniformLocation;
  type: number;
  size: number;
  unit: number;
}

export class Program {
  readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, UniformInfo>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vsSource: string,
    fsSource: string,
    label = 'program',
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSource, label);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, label);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`[${label}] link failed: ${log}`);
    }
    this.program = program;
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(program, name);
      if (!loc) continue;
      const isSampler = info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_3D || info.type === gl.UNSIGNED_INT_SAMPLER_2D;
      this.uniforms.set(name, { loc, type: info.type, size: info.size, unit: isSampler ? unit++ : -1 });
    }
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  has(name: string): boolean {
    return this.uniforms.has(name);
  }

  /** Set a uniform by name. Unknown names are ignored (the shader may have optimised them out). */
  set(name: string, value: UniformValue): void {
    const u = this.uniforms.get(name);
    if (!u || value === undefined) return;
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT:
        if (typeof value === 'number') gl.uniform1f(u.loc, value);
        else if (typeof value === 'boolean') gl.uniform1f(u.loc, value ? 1 : 0);
        else if (value && 'length' in (value as object)) gl.uniform1fv(u.loc, value as number[]);
        break;
      case gl.INT:
      case gl.BOOL:
        gl.uniform1i(u.loc, typeof value === 'boolean' ? (value ? 1 : 0) : (value as number));
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(u.loc, value as number[]);
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(u.loc, value as number[]);
        break;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(u.loc, value as number[]);
        break;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(u.loc, false, value as Float32Array);
        break;
      case gl.FLOAT_MAT4:
        gl.uniformMatrix4fv(u.loc, false, value as Float32Array);
        break;
      case gl.SAMPLER_2D:
      case gl.UNSIGNED_INT_SAMPLER_2D:
        gl.activeTexture(gl.TEXTURE0 + u.unit);
        gl.bindTexture(gl.TEXTURE_2D, value as WebGLTexture | null);
        gl.uniform1i(u.loc, u.unit);
        break;
      case gl.SAMPLER_3D:
        gl.activeTexture(gl.TEXTURE0 + u.unit);
        gl.bindTexture(gl.TEXTURE_3D, value as WebGLTexture | null);
        gl.uniform1i(u.loc, u.unit);
        break;
    }
  }

  setAll(values: Record<string, UniformValue>): void {
    for (const k in values) this.set(k, values[k]);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
      .join('\n');
    throw new Error(`[${label}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed to compile:\n${log}\n${numbered}`);
  }
  return shader;
}

export interface RenderTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** As FULLSCREEN_VS but flips vertically: used only when presenting to the canvas. */
export const PRESENT_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export interface GlCaps {
  floatTargets: boolean;
  floatLinear: boolean;
  maxTextureSize: number;
}

export class Glx {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCaps;
  /** When true, pooled render targets are RGBA16F. */
  useFloat: boolean;
  private readonly vao: WebGLVertexArrayObject;
  private readonly programs = new Map<string, Program>();
  private readonly pool = new Map<string, RenderTarget[]>();
  private live = 0;
  private lost = false;

  constructor(gl: WebGL2RenderingContext, preferFloat = true) {
    this.gl = gl;
    const cbf = gl.getExtension('EXT_color_buffer_float');
    const cbhf = gl.getExtension('EXT_color_buffer_half_float');
    const lin = gl.getExtension('OES_texture_float_linear');
    this.caps = {
      floatTargets: !!(cbf || cbhf),
      floatLinear: !!lin,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
    this.useFloat = preferFloat && this.caps.floatTargets;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  get contextLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  markLost(): void {
    this.lost = true;
    this.programs.clear();
    this.pool.clear();
  }

  /** Compile (or fetch a cached) program. `key` must uniquely identify the fragment source. */
  program(key: string, fs: string, vs: string = FULLSCREEN_VS): Program {
    let p = this.programs.get(key);
    if (!p) {
      p = new Program(this.gl, vs, fs, key);
      this.programs.set(key, p);
    }
    return p;
  }

  /** Take a render target from the pool. Contents are undefined until drawn or cleared. */
  acquire(width: number, height: number): RenderTarget {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = `${w}x${h}:${this.useFloat ? 'f' : 'b'}`;
    const list = this.pool.get(key);
    if (list && list.length) return list.pop()!;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.useFloat) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.live++;
    return { fbo, tex, width: w, height: h };
  }

  release(rt: RenderTarget | null | undefined): void {
    if (!rt) return;
    const key = `${rt.width}x${rt.height}:${this.useFloat ? 'f' : 'b'}`;
    let list = this.pool.get(key);
    if (!list) this.pool.set(key, (list = []));
    list.push(rt);
  }

  /** Free pooled targets that do not match the current working size (call after a resize). */
  trimPool(keep?: (rt: RenderTarget) => boolean): void {
    const gl = this.gl;
    for (const [key, list] of this.pool) {
      const kept: RenderTarget[] = [];
      for (const rt of list) {
        if (keep && keep(rt)) kept.push(rt);
        else {
          gl.deleteFramebuffer(rt.fbo);
          gl.deleteTexture(rt.tex);
          this.live--;
        }
      }
      if (kept.length) this.pool.set(key, kept);
      else this.pool.delete(key);
    }
  }

  get liveTargets(): number {
    return this.live;
  }

  bind(target: RenderTarget | null, canvasWidth = 0, canvasHeight = 0): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    if (target) gl.viewport(0, 0, target.width, target.height);
    else gl.viewport(0, 0, canvasWidth, canvasHeight);
  }

  clear(target: RenderTarget | null, r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    if (target) this.bind(target);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Draw the full-screen triangle with the currently bound program. */
  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Run a full-screen pass into `target`. */
  pass(program: Program, target: RenderTarget | null, uniforms: Record<string, UniformValue>, blend = false): void {
    const gl = this.gl;
    if (target) this.bind(target);
    program.use();
    program.setAll(uniforms);
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    this.draw();
  }

  createTexture(filter: number = this.gl.LINEAR): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  dispose(): void {
    this.trimPool();
    for (const p of this.programs.values()) p.dispose();
    this.programs.clear();
  }
}
