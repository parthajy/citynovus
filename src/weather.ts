// Real weather for the real city. Open-Meteo, no key, refreshed every ten minutes.
// Day and night come from the actual sun; rain, drizzle, thunder and fog are drawn on a canvas over the map.
import { CITY } from './config';

export interface Weather {
  temp: number; feels: number; humidity: number; wind: number; cloud: number;
  precip: number; code: number; isDay: boolean; time: string;
  hourly: { time: string; prob: number; mm: number }[];
}

const CODES: Record<number, { label: string; icon: string }> = {
  0: { label: 'Clear', icon: 'clear_day' }, 1: { label: 'Mostly clear', icon: 'partly_cloudy_day' }, 2: { label: 'Partly cloudy', icon: 'partly_cloudy_day' }, 3: { label: 'Overcast', icon: 'cloud' },
  45: { label: 'Fog', icon: 'foggy' }, 48: { label: 'Fog', icon: 'foggy' },
  51: { label: 'Light drizzle', icon: 'rainy_light' }, 53: { label: 'Drizzle', icon: 'rainy_light' }, 55: { label: 'Heavy drizzle', icon: 'rainy' },
  61: { label: 'Light rain', icon: 'rainy_light' }, 63: { label: 'Rain', icon: 'rainy' }, 65: { label: 'Heavy rain', icon: 'rainy_heavy' },
  80: { label: 'Showers', icon: 'rainy' }, 81: { label: 'Showers', icon: 'rainy' }, 82: { label: 'Violent showers', icon: 'rainy_heavy' },
  95: { label: 'Thunderstorm', icon: 'thunderstorm' }, 96: { label: 'Thunderstorm with hail', icon: 'thunderstorm' }, 99: { label: 'Thunderstorm with hail', icon: 'thunderstorm' },
};
export function describe(w: Weather): { label: string; icon: string } {
  const c = CODES[w.code] ?? { label: 'Cloudy', icon: 'cloud' };
  if (!w.isDay && c.icon.endsWith('_day')) return { label: c.label, icon: c.icon.replace('_day', '_night') };
  return c;
}
/** 0 = dry, 1 = torrential. */
export function rainLevel(w: Weather): number {
  const byCode: Record<number, number> = { 51: 0.15, 53: 0.25, 55: 0.35, 61: 0.35, 63: 0.6, 65: 0.9, 80: 0.5, 81: 0.7, 82: 1, 95: 0.85, 96: 1, 99: 1 };
  return Math.max(byCode[w.code] ?? 0, Math.min(1, w.precip / 8));
}
export const isThunder = (w: Weather) => w.code >= 95;
export const isFog = (w: Weather) => w.code === 45 || w.code === 48;
/** Alerts worth a nudge to Banpani, which has the official IMD layers. */
export function severe(w: Weather): string | null {
  if (w.code >= 95) return 'Thunderstorm over the city';
  if (w.code === 65 || w.code === 82) return 'Heavy rain: low wards may flood';
  if (w.feels >= 42) return 'Heat wave conditions';
  return null;
}

export async function fetchWeather(at: [number, number] = CITY.center): Promise<Weather> {
  const [lon, lat] = at;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m&hourly=precipitation_probability,precipitation&forecast_hours=8&timezone=Asia%2FKolkata`;
  const j = await (await fetch(url)).json();
  const c = j.current;
  const hourly = (j.hourly.time as string[]).map((t, i) => ({ time: t, prob: j.hourly.precipitation_probability[i] ?? 0, mm: j.hourly.precipitation[i] ?? 0 }));
  return { temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m, cloud: c.cloud_cover, precip: c.precipitation, code: c.weather_code, isDay: c.is_day === 1, time: c.time, hourly };
}

// ---- the sun, so light and night are astronomically honest ----
const rad = Math.PI / 180;
export function sunPosition(date: Date, lat: number, lon: number): { altitude: number; azimuth: number } {
  const d = date.getTime() / 86400000 - 0.5 + 2440588 - 2451545;
  const M = rad * (357.5291 + 0.98560028 * d);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const e = rad * 23.4397;
  const dec = Math.asin(Math.sin(L) * Math.sin(e));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const lw = rad * -lon, phi = rad * lat;
  const H = rad * (280.16 + 360.9856235 * d) - lw - ra;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)); // from south, westward
  return { altitude: altitude / rad, azimuth: ((azimuth / rad + 180) % 360 + 360) % 360 }; // azimuth clockwise from north
}
export const isNight = (date = new Date(), at: [number, number] = CITY.center) => sunPosition(date, at[1], at[0]).altitude < -4;

// ---- rain, thunder, stars, fog ----
export class WeatherFX {
  private ctx: CanvasRenderingContext2D;
  private drops: { x: number; y: number; l: number; v: number }[] = [];
  private stars: { x: number; y: number; r: number; p: number }[] = [];
  private raf = 0;
  private flashUntil = 0;
  private nextFlash = 0;
  level = 0; thunder = false; fog = false; night = false; pitch = 55; wind = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const resize = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; this.stars = []; };
    addEventListener('resize', resize); resize();
  }
  apply(w: Weather | null, night: boolean, pitch: number) {
    this.night = night; this.pitch = pitch;
    this.level = w ? rainLevel(w) : 0;
    this.thunder = !!w && isThunder(w);
    this.fog = !!w && isFog(w);
    this.wind = w ? Math.min(1, w.wind / 40) : 0;
    const want = Math.round(this.level * 420);
    while (this.drops.length < want) this.drops.push(this.drop(true));
    this.drops.length = Math.min(this.drops.length, want);
    const busy = this.level > 0 || this.night || this.fog;
    if (busy && !this.raf) this.raf = requestAnimationFrame(() => this.frame());
    if (!busy && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  }
  private drop(anywhere = false) {
    const { width, height } = this.canvas;
    return { x: Math.random() * width * 1.2 - width * 0.1, y: anywhere ? Math.random() * height : -20, l: (10 + Math.random() * 18) * devicePixelRatio, v: (9 + Math.random() * 7) * devicePixelRatio };
  }
  private frame() {
    const { ctx, canvas } = this;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    if (this.night && this.pitch > 20) {
      const band = height * Math.min(0.42, 0.1 + (this.pitch - 20) * 0.007);
      if (!this.stars.length) for (let i = 0; i < 140; i++) this.stars.push({ x: Math.random() * width, y: Math.random() * band, r: (0.5 + Math.random() * 1.1) * devicePixelRatio, p: Math.random() * 6 });
      const t = performance.now() / 1000;
      for (const s of this.stars) {
        const a = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.3 + s.p))) * (1 - s.y / band) * (this.level ? 0.15 : 1);
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (this.fog) { ctx.fillStyle = 'rgba(225,225,225,0.28)'; ctx.fillRect(0, 0, width, height); }
    if (this.level > 0) {
      ctx.strokeStyle = this.night ? 'rgba(200,215,235,0.35)' : 'rgba(120,140,170,0.35)';
      ctx.lineWidth = 1.1 * devicePixelRatio;
      const dx = this.wind * 3 * devicePixelRatio;
      ctx.beginPath();
      for (const d of this.drops) {
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - dx, d.y + d.l);
        d.y += d.v * (0.8 + this.level * 0.6); d.x -= dx;
        if (d.y > height) Object.assign(d, this.drop());
      }
      ctx.stroke();
      if (this.thunder) {
        const now = performance.now();
        if (!this.nextFlash) this.nextFlash = now + 3000 + Math.random() * 9000;
        if (now > this.nextFlash) { this.flashUntil = now + 220; this.nextFlash = now + 6000 + Math.random() * 14000; }
        if (now < this.flashUntil) { ctx.fillStyle = `rgba(255,255,255,${(0.75 * (this.flashUntil - now) / 220).toFixed(2)})`; ctx.fillRect(0, 0, width, height); }
      }
    }
    this.raf = requestAnimationFrame(() => this.frame());
  }
}
