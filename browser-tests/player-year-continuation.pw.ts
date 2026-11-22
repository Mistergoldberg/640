import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { currentCatalogueFixture, installSyntheticMedia } from './support/catalogue';
import type { YearIndex } from '../src/types';

const fixture = currentCatalogueFixture();
const indexFor = (year: string): YearIndex => JSON.parse(fs.readFileSync(path.resolve('public/data',year,'index.json'),'utf8'));
const last = fixture.photos.at(-1)!;
const nextIndex = indexFor(fixture.adjacent);
const nextFirst = nextIndex.sequence[0].id;
const visibleImage = (page: Page) => page.locator('.player-image:not(.player-image--incoming)');
async function pause(page: Page) {
  await page.evaluate(() => { const button=document.querySelector<HTMLButtonElement>('[data-player-control="playback"]');if(button?.getAttribute('aria-label')==='Pause')button.click(); });
}
async function openLast(page: Page) {
  await page.goto(`/?year=${fixture.newest}&photo=${last.id}`);
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id', last.id);
  await expect(page.getByRole('dialog',{name:'Photo player'})).not.toHaveAttribute('data-player-status','loading');
  if(await page.locator('[data-player-control="playback"]').getAttribute('aria-label')==='Play') await page.locator('[data-player-control="playback"]').click();
  await pause(page);
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveAttribute('data-player-status','explicitly-paused');
}
async function crossManually(page: Page) {
  await page.locator('[data-player-control="forward"]').click();
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',nextFirst,{timeout:20000});
}

test.beforeEach(async ({page}) => {
  if (process.env.PIXILATION_BROWSER_REAL_MEDIA !== "1") await installSyntheticMedia(page);
  await page.addInitScript(() => localStorage.setItem('pixilation-player-onboarding-v1','1'));
});

test('autoplay preloads and crosses the year without remounting, fullscreen loss or added history',async ({page})=>{
  const images:string[]=[];page.on('request',r=>{if(r.url().includes(`/${fixture.adjacent}/display/`))images.push(r.url());});
  await page.goto(`/?year=${fixture.newest}&photo=${fixture.photos.at(-4)!.id}`);
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',fixture.photos.at(-4)!.id);
  await pause(page);
  await expect.poll(()=>images.length).toBeGreaterThan(0);
  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole('radio',{name:'0.25 seconds per photo',exact:true}).click();
  await page.locator('[data-player-control="screen-mode"]').click();
  await expect.poll(()=>page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true);
  const history = await page.evaluate(() => { (window as unknown as { playerNode:Element|null }).playerNode=document.querySelector('[role="dialog"][aria-label="Photo player"]');return window.history.length; });
  await page.locator('[data-player-control="playback"]').click();
  await expect(page).toHaveURL(new RegExp(`year=${fixture.adjacent}&photo=${nextFirst}`),{timeout:20000});
  await pause(page);
  expect(await page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true);
  expect(await page.evaluate(()=>window.history.length)).toBe(history);
  await expect(page.locator('[data-player-control="speed"]')).toHaveAttribute('aria-label','Playback speed: 0.25 seconds per photo');
  expect(await page.evaluate(()=>(window as unknown as {playerNode:Element|null}).playerNode===document.querySelector('[role="dialog"][aria-label="Photo player"]'))).toBe(true);
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',new RegExp(`^${fixture.adjacent}-`));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveCount(0);
  await expect(page.locator('.collection-shell')).toHaveAttribute('data-active-year',fixture.adjacent);
});

test('manual crossing stays paused, steps backward across the boundary, and preserves share and reload targets',async ({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async(data:ShareData)=>{(window as unknown as {sharedUrl?:string}).sharedUrl=data.url;}}));
  await openLast(page);await crossManually(page);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute('aria-label','Play');
  await page.locator('[data-player-control="share"]').click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {sharedUrl?:string}).sharedUrl)).toBeTruthy();
  const shared=await page.evaluate(()=>(window as unknown as {sharedUrl:string}).sharedUrl);
  expect(new URL(shared).searchParams.get('year')).toBe(fixture.adjacent);
  expect(new URL(shared).searchParams.get('photo')).toBe(nextFirst);
  await page.locator('[data-player-control="back"]').click();
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',last.id,{timeout:20000});
  await crossManually(page);
  await page.reload();await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',nextFirst);
});

test('a failed next-year manifest holds the last frame and retries without skipping it',async ({page})=>{
  let fail=true;
  await page.route(`**/data/${fixture.adjacent}/albums/**`,route=>fail?route.fulfill({status:503,body:'unavailable'}):route.continue());
  await openLast(page);
  await page.locator('[data-player-control="forward"]').click();
  await expect(page.getByRole('button',{name:'Retry year',exact:true})).toBeVisible();
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',last.id);
  fail=false;await page.getByRole('button',{name:'Retry year',exact:true}).click();
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',nextFirst,{timeout:20000});
});

test('pause cancels a pending autoplay handoff and late data does not move the frame',async ({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/data/${fixture.adjacent}/albums/**`,async route=>{await gate;try{await route.continue();}catch{/* closed page */}});
  await openLast(page);await page.locator('[data-player-control="playback"]').click();
  await expect(page.getByRole('status').filter({hasText:'Preparing next photos'})).toBeVisible();
  await pause(page);release();
  await expect(page.getByRole('status').filter({hasText:'Preparing next photos'})).toHaveCount(0);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute('aria-label','Play');
  await page.waitForTimeout(500); // Allow the deliberately delayed response to settle.
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',last.id);
  await page.locator('[data-player-control="playback"]').click();
  await expect(page).toHaveURL(new RegExp(`year=${fixture.adjacent}&photo=${nextFirst}`),{timeout:20000});
});

test('close cancels a pending handoff without reopening the player or rewriting the album URL',async ({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/data/${fixture.adjacent}/albums/**`,async route=>{await gate;try{await route.continue();}catch{/* cancelled request */}});
  await openLast(page);await page.keyboard.press('Escape');
  const tile=page.locator(`[data-photo-id="${last.id}"]`);
  await expect(tile).toBeFocused();await tile.click();
  await page.locator('[data-player-control="forward"]').click();
  await expect(page.getByRole('status').filter({hasText:'Preparing next photos'})).toBeVisible();
  await page.keyboard.press('Escape');release();
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(new RegExp(`year=${fixture.newest}(?!.*photo)`));
});

test('the oldest catalogue year ends without wrapping to the newest',async ({page})=>{
  const oldest=indexFor(fixture.oldest).sequence.at(-1)!.id;
  await page.goto(`/?year=${fixture.oldest}&photo=${oldest}`);
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',oldest);
  await expect(page.locator('[data-player-control="forward"]')).toBeDisabled();
  await expect(page).toHaveURL(new RegExp(`year=${fixture.oldest}&photo=${oldest}`));
});

test('Escape after a grid-launched year crossing focuses the displayed photo; Back and Forward remain usable',async ({page})=>{
  await openLast(page);await page.keyboard.press('Escape');
  const tile=page.locator(`[data-photo-id="${last.id}"]`);
  await expect(tile).toBeFocused();await tile.click();
  await crossManually(page);await pause(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveCount(0);
  await expect(page.locator('.collection-shell')).toHaveAttribute('data-active-year',fixture.adjacent);
  await expect(page.locator(`[data-photo-id="${nextFirst}"]`)).toBeFocused();
  await page.goForward();
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',nextFirst);
  await page.goBack();
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveCount(0);
});

test.describe('touch continuation',()=>{
 test.use({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
 test('crosses in both directions and retains the player through orientation change',async ({page})=>{
  await openLast(page);await crossManually(page);
  await page.setViewportSize({width:844,height:390});
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveAttribute('data-player-year',fixture.adjacent);
  await page.locator('[data-player-control="back"]').click();
  await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',last.id,{timeout:20000});
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveCount(0);
 });
});

test('continuation follows catalogue adjacency across a missing calendar year',async ({page})=>{
 const lastAdjacent=nextIndex.sequence.at(-1)!.id;
 const firstThird=indexFor(fixture.third).sequence[0].id;
 await page.goto(`/?year=${fixture.adjacent}&photo=${lastAdjacent}`);
 await expect(visibleImage(page)).toHaveAttribute('data-player-photo-id',lastAdjacent);
 await expect(page).toHaveURL(new RegExp(`year=${fixture.third}&photo=${firstThird}`),{timeout:20000});
 await pause(page);
 await expect(page.getByRole('dialog',{name:'Photo player'})).toHaveAttribute('data-player-year',fixture.third);
});
