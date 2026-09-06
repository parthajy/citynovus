import { CITY } from './config';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export async function shareCard(neighbourhood: string, built: number, total: number): Promise<'shared' | 'downloaded'> {
  const pct = total ? Math.round((built / total) * 100) : 0;
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 630;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f5f0e6'; ctx.fillRect(0, 0, 1200, 630);
  ctx.fillStyle = '#104050';
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.fillText('CITYNOVUS', 70, 100);
  ctx.font = '32px system-ui, sans-serif'; ctx.fillStyle = '#555';
  ctx.fillText(`${CITY.name} builds its own map`, 70, 150);
  ctx.fillStyle = '#1b1b1b'; ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.fillText(neighbourhood.toUpperCase(), 70, 290);
  ctx.font = 'bold 150px system-ui, sans-serif'; ctx.fillStyle = '#e07a5f';
  ctx.fillText(`${pct}%`, 70, 460);
  ctx.font = '36px system-ui, sans-serif'; ctx.fillStyle = '#555';
  ctx.fillText(`built · ${built} of ${total} buildings coloured in`, 70, 520);
  ctx.fillStyle = '#ddd'; roundRect(ctx, 70, 560, 1060, 22, 11); ctx.fill();
  ctx.fillStyle = '#3d8b6e'; roundRect(ctx, 70, 560, Math.max(22, 1060 * pct / 100), 22, 11); ctx.fill();
  ctx.font = '28px system-ui, sans-serif'; ctx.fillStyle = '#888';
  ctx.textAlign = 'right'; ctx.fillText('citynovus.com', 1130, 100);

  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
  const file = new File([blob], `township-${neighbourhood.toLowerCase().replace(/\W+/g, '-')}.png`, { type: 'image/png' });
  const text = `${neighbourhood} is ${pct}% built on CityNovus. Come colour in your street: citynovus.com`;
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: `${neighbourhood} on CityNovus`, text });
    return 'shared';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
