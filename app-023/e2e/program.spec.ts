// E2E —— 整台编排：建台 → 选段 → 接头过渡小节 → 时间重算 → 抽段/放回 → 调序 → 生成试听 → 退回编排前
import { expect, test, type Page } from '@playwright/test';

async function loadPattern(page: Page, id: string): Promise<string> {
  await page.goto('#/library');
  await page.getByTestId(`load-${id}`).click();
  await expect(page.getByTestId('editor-page')).toBeVisible();
  const href = page.evaluate(() => window.location.hash);
  return (await href).replace('#/score/', '');
}

async function newProgram(page: Page, name: string): Promise<void> {
  await page.goto('#/programs');
  await page.getByTestId('new-program-title').fill(name);
  await page.getByTestId('btn-create-program').click();
  await expect(page.getByTestId('program-editor')).toBeVisible();
}

test.describe('整台编排', () => {
  test('从曲牌库选段建台：2/4 段接 4/4 段自动补过渡、时间轴汇总', async ({ page }) => {
    // 急急风 2/4、四击头 4/4
    const jiji = await loadPattern(page, 'jijifeng');
    const siji = await loadPattern(page, 'sijitou');
    await newProgram(page, 'E2E 一台');

    await page.getByTestId(`add-seg-${jiji}`).click();
    await page.getByTestId(`add-seg-${siji}`).click();

    // 第二段前出现过渡标记（2/4→4/4）
    await expect(page.locator('[data-testid^="joint-"]')).toHaveCount(1);

    // 时间轴块：段 + 过渡 + 段
    const rows = page.locator('[data-testid^="block-row-"]');
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId('block-row-1')).toContainText('2/4→4/4');

    // 急急风 4 小节 → 过渡第 5 小节 → 四击头第 6 小节起
    const sijiTime = page.locator('[data-testid^="seg-time-"]').nth(1);
    await expect(sijiTime).toContainText('第 6–7 小节');

    const total = await page.getByTestId('prog-total').textContent();
    expect(total).toContain('共 7 小节'); // 4 + 1 过渡 + 2
    expect(total).toMatch(/总时长/);
  });

  test('同拍号两段不补过渡', async ({ page }) => {
    const chong = await loadPattern(page, 'chongtou'); // 2/4
    const jiji = await loadPattern(page, 'jijifeng'); // 2/4
    await newProgram(page, 'E2E 同拍号');
    await page.getByTestId(`add-seg-${chong}`).click();
    await page.getByTestId(`add-seg-${jiji}`).click();
    await expect(page.locator('[data-testid^="joint-"]')).toHaveCount(0);
    const rows = page.locator('[data-testid^="block-row-"]');
    await expect(rows).toHaveCount(2);
  });

  test('调序与临时抽放：时间随改动重算', async ({ page }) => {
    const jiji = await loadPattern(page, 'jijifeng'); // 2/4
    const siji = await loadPattern(page, 'sijitou'); // 4/4
    await newProgram(page, 'E2E 调序');
    await page.getByTestId(`add-seg-${jiji}`).click();
    await page.getByTestId(`add-seg-${siji}`).click();
    expect(await page.locator('[data-testid^="joint-"]').count()).toBe(1);

    // 临时抽掉第二段：接头消失、总小节变化
    const sijiKey = (await page
      .locator('[data-testid^="arrange-item-"]')
      .nth(1)
      .getAttribute('data-testid'))!.replace('arrange-item-', '');
    await page.getByTestId(`toggle-${sijiKey}`).click();
    await expect(page.locator('[data-testid^="joint-"]')).toHaveCount(0);
    await expect(page.getByTestId('prog-total')).toContainText('共 4 小节');

    // 放回：接头恢复
    await page.getByRole('button', { name: '放回' }).click();
    await expect(page.locator('[data-testid^="joint-"]')).toHaveCount(1);
    await expect(page.getByTestId('prog-total')).toContainText('共 7 小节');

    // 把第二段上移到最前：过渡变成 4/4→2/4
    await page.getByTestId(`move-up-${sijiKey}`).click();
    await expect(page.getByTestId('block-row-1')).toContainText('4/4→2/4');
  });

  test('整台生成试听 → 多速度调度发声 → 退回编排前（空台子）', async ({ page }) => {
    const jiji = await loadPattern(page, 'jijifeng');
    const siji = await loadPattern(page, 'sijitou');
    await newProgram(page, 'E2E 试听退回');
    await page.getByTestId(`add-seg-${jiji}`).click();
    await page.getByTestId(`add-seg-${siji}`).click();

    await page.getByTestId('btn-generate').click();
    await expect(page.getByTestId('prog-preview')).toBeVisible();
    // 预览含 3 个块（段/过渡/段）
    await expect(page.locator('[data-testid^="preview-block-"]')).toHaveCount(3);
    const jointBlock = page.locator('[data-kind="transition"]');
    await expect(jointBlock).toHaveCount(1);
    await expect(jointBlock).toContainText('2/4 接 4/4');

    await page.getByTestId('btn-prog-play').click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __programScheduled?: () => { time: number }[] }).__programScheduled?.().length ?? 0,
          ),
        { timeout: 8000, intervals: [200] },
      )
      .toBeGreaterThan(5);
    // 事件时刻单调不减（多速度拼接也有序）
    const monotonic = await page.evaluate(() => {
      const evs = (window as unknown as { __programScheduled?: () => { time: number }[] }).__programScheduled?.() ?? [];
      return evs.every((e, i) => i === 0 || e.time >= evs[i - 1].time - 1e-9);
    });
    expect(monotonic).toBe(true);

    // 退回编排前：回到编辑态且台子清空（进入时是空台子）
    await page.getByTestId('btn-revert').click();
    await expect(page.getByTestId('prog-preview')).toHaveCount(0);
    await expect(page.getByTestId('prog-arrange')).toBeVisible();
    await expect(page.locator('[data-testid^="arrange-item-"]')).toHaveCount(0);
    await expect(page.getByTestId('prog-total')).toContainText('共 0 小节');
  });

  test('整台持久化：刷新后编排不丢', async ({ page }) => {
    const jiji = await loadPattern(page, 'jijifeng');
    const siji = await loadPattern(page, 'sijitou');
    await newProgram(page, 'E2E 整台持久化');
    await page.getByTestId(`add-seg-${jiji}`).click();
    await page.getByTestId(`add-seg-${siji}`).click();
    await page.waitForTimeout(700); // 等防抖保存
    await page.reload();
    await expect(page.getByTestId('program-editor')).toBeVisible();
    await expect(page.locator('[data-testid^="arrange-item-"]')).toHaveCount(2);
    await expect(page.locator('[data-testid^="joint-"]')).toHaveCount(1);
  });

  test('整台列表：新建后出现在列表，可删除', async ({ page }) => {
    await newProgram(page, 'E2E 列表整台');
    await page.goto('#/programs');
    const row = page.locator('tr', { hasText: 'E2E 列表整台' });
    await expect(row).toBeVisible();
    page.once('dialog', (d) => d.accept());
    const pid = (await row.getAttribute('data-testid'))!.replace('program-row-', '');
    await page.getByTestId(`del-program-${pid}`).click();
    await expect(page.locator('tr', { hasText: 'E2E 列表整台' })).toHaveCount(0);
  });
});
