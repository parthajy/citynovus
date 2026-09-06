// The sign-in screen: a short hand-made animation in the logo's line-art style, then the card.
// Nothing here touches the map, so it is smooth on any device. Skippable after a second.
import type { Session, Store } from './types';
import type { WorldMap } from './map';

type DriveCtor = typeof import('./intro3d').Drive;

export class LoginScreen {
  private el: HTMLElement;
  private skipTimer = 0;
  private drive: InstanceType<DriveCtor> | null = null;
  private DriveClass: DriveCtor | null = null;
  onClosed: () => void = () => {};

  constructor(_world: WorldMap, private store: Store, private session: () => Session, _toast: (m: string, k?: 'ok' | 'err') => void) {
    this.el = document.getElementById('login')!;
    // Warm the 3D module in the background so the first tap on Log in starts instantly.
    setTimeout(() => { void import('./intro3d').then((m) => { this.DriveClass = m.Drive; }); }, 4000);
    this.el.addEventListener('click', (ev) => void this.onClick(ev));
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !this.el.hidden) this.close(); });
  }

  open(reason = '') {
    if (!this.el.hidden) return;
    const s = this.session();
    this.el.querySelector<HTMLElement>('#login-reason')!.textContent = reason;
    this.el.querySelector<HTMLElement>('#login-google')!.hidden = !s.authMethods.google;
    this.el.querySelector<HTMLElement>('#login-email-toggle')!.hidden = !s.authMethods.password;
    this.el.querySelector<HTMLElement>('#login-email')!.hidden = true;
    this.el.querySelector<HTMLElement>('#login-none')!.hidden = s.authMethods.google || s.authMethods.password;
    this.el.querySelector<HTMLElement>('#login-msg')!.textContent = '';
    this.el.querySelector<HTMLElement>('#login-unsaved')!.textContent = s.unsaved > 0 ? `You have ${s.unsaved} unsaved ${s.unsaved === 1 ? 'thing' : 'things'} on the map. Log in and they are yours for good.` : `Guests can build, but guest work disappears after ${s.provisionalHours} hours. Log in to keep it.`;
    this.store.track('login_open');

    const first = (() => { try { return localStorage.getItem('tw.flown') !== '1'; } catch { return true; } })();
    try { localStorage.setItem('tw.flown', '1'); } catch { /* ignore */ }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = reduced ? 0 : first ? 5000 : 3000;
    this.el.classList.remove('card-on', 'play');
    this.el.querySelector<HTMLElement>('#login-skip')!.hidden = true;
    this.el.hidden = false;
    void this.start(total);
  }

  private async start(total: number) {
    const canvas = this.el.querySelector<HTMLCanvasElement>('#intro-canvas')!;
    try {
      if (!this.DriveClass) this.DriveClass = (await import('./intro3d')).Drive;
      if (this.el.hidden) return;
      this.drive?.dispose();
      this.drive = new this.DriveClass(canvas);
    } catch { this.showCard(); return; } // no WebGL: straight to the card
    if (total === 0) { this.drive.skip(); return; }
    this.el.classList.add('play');
    this.skipTimer = window.setTimeout(() => { this.el.querySelector<HTMLElement>('#login-skip')!.hidden = false; }, 1000);
    this.drive.play(total, () => this.showCard());
  }

  private showCard() {
    clearTimeout(this.skipTimer);
    this.el.querySelector<HTMLElement>('#login-skip')!.hidden = true;
    this.el.classList.add('card-on');
  }

  close() {
    if (this.el.hidden) return;
    clearTimeout(this.skipTimer);
    this.drive?.dispose(); this.drive = null;
    this.el.hidden = true;
    this.el.classList.remove('card-on', 'play');
    this.onClosed();
  }

  private async onClick(ev: Event) {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-login]');
    if (!b) return;
    ev.preventDefault();
    const a = b.dataset.login;
    const msg = this.el.querySelector<HTMLElement>('#login-msg')!;
    const val = (id: string) => this.el.querySelector<HTMLInputElement>(id)!.value;
    try {
      if (a === 'skip') { this.drive ? this.drive.skip() : this.showCard(); }
      else if (a === 'close') this.close();
      else if (a === 'google') { b.setAttribute('aria-busy', 'true'); this.store.track('login_google'); location.href = await this.store.googleStart(); }
      else if (a === 'email-toggle') { const f = this.el.querySelector<HTMLElement>('#login-email')!; f.hidden = !f.hidden; }
      else if (a === 'login') { await this.store.login(val('#login-em'), val('#login-pw')); location.href = '/?login=1'; }
      else if (a === 'register') { await this.store.register(val('#login-em'), val('#login-pw'), val('#login-name')); location.href = '/?login=1'; }
      else if (a === 'forgot') msg.textContent = await this.store.forgot(val('#login-em'));
      else if (a === 'reset') { const t = new URLSearchParams(location.search).get('reset') ?? ''; msg.textContent = await this.store.reset(t, val('#login-pw')); setTimeout(() => { location.href = '/?login=1'; }, 800); }
    } catch (e) { msg.textContent = (e as Error).message; b.removeAttribute('aria-busy'); }
  }
}
