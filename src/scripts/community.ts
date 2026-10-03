interface Share {
  id: string;
  gameId: string;
  url: string;
  provider: string;
  code: string;
  version: string;
  nickname: string;
  note: string;
  createdAt: string;
  reportCount: number;
}
interface Config {
  submissionEnabled: boolean;
  providers: { id: string; label: string }[];
}
export {};

const root = document.querySelector<HTMLElement>('#community');
if (root) initialize(root);

function initialize(root: HTMLElement) {
  const gameId = root.dataset.gameId!;
  const query = <T extends HTMLElement>(id: string) => document.querySelector<T>(id)!;
  const shareDialog = query<HTMLDialogElement>('#share-dialog');
  const reportDialog = query<HTMLDialogElement>('#report-dialog');
  const shareForm = query<HTMLFormElement>('#share-form');
  const reportForm = query<HTMLFormElement>('#report-form');
  const list = query('#shares-list');
  const providerNames: Record<string, string> = {
    baidu: '百度网盘',
    quark: '夸克网盘',
    aliyun: '阿里云盘',
    uc: 'UC 网盘',
    '123pan': '123 云盘',
  };
  let page = 1;
  let listingRequest = 0;
  let selectedReport = '';
  let config: Config | undefined;
  let configPromise: Promise<Config> | undefined;
  const ready = { share: false, report: false };
  const busy = { share: false, report: false };

  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    let value: T & { error?: string };
    try {
      value = await response.json();
    } catch {
      throw new Error('分享服务暂时不可用，请稍后再试。');
    }
    if (!response.ok) throw new Error(value.error || '请求未成功，请稍后再试。');
    return value;
  }
  function errorText(error: unknown) {
    return error instanceof Error && error.name === 'TimeoutError'
      ? '连接超时，请重试。'
      : error instanceof TypeError
        ? '网络连接失败，请重试。'
        : error instanceof Error
          ? error.message
          : '暂时无法完成，请重试。';
  }
  function announce(message: string) {
    const el = query('#community-message');
    el.textContent = message;
    el.hidden = false;
  }
  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function renderShare(share: Share) {
    const card = element('article', 'share-card');
    const heading = element('div', 'share-card-heading');
    const meta = element('div', 'share-card-meta');
    meta.append(
      element(
        'span',
        `provider provider-${share.provider}`,
        providerNames[share.provider] || '网盘分享',
      ),
    );
    meta.append(element('h3', '', share.version || '未注明游戏版本'));
    heading.append(meta);
    const date = new Date(share.createdAt);
    const time = element(
      'time',
      'share-time',
      Number.isNaN(date.getTime())
        ? ''
        : new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(date),
    );
    time.dateTime = share.createdAt;
    heading.append(time);
    card.append(heading);
    card.append(element('p', 'share-author', `${share.nickname || '匿名玩家'} 分享`));
    if (share.note) card.append(element('p', 'share-note', share.note));
    const url = element('p', 'share-url', share.url);
    card.append(url);
    const bottom = element('div', 'share-card-bottom');
    const actions = element('div', 'share-actions');
    const link = element('a', 'button secondary small', '打开网盘');
    link.href = share.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow ugc';
    actions.append(link);
    if (share.code) {
      const copy = element('button', 'copy-code', `提取码 ${share.code} · 复制`);
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(share.code);
          copy.textContent = '提取码已复制';
          setTimeout(() => {
            copy.textContent = `提取码 ${share.code} · 复制`;
          }, 2200);
        } catch {
          announce(`复制未成功，提取码是：${share.code}`);
        }
      });
      actions.append(copy);
    }
    bottom.append(actions);
    const feedback = element('div', 'share-feedback');
    if (share.reportCount > 0)
      feedback.append(element('span', 'report-count', `${share.reportCount} 次失效反馈`));
    const report = element('button', 'report-link', '反馈失效');
    report.type = 'button';
    report.addEventListener('click', () => {
      selectedReport = share.id;
      reportDialog.showModal();
      void prepareForm('report');
    });
    feedback.append(report);
    bottom.append(feedback);
    card.append(bottom);
    list.append(card);
  }
  async function loadShares(nextPage = 1) {
    const request = ++listingRequest;
    query('#shares-loading').hidden = false;
    query('#shares-error').hidden = true;
    query('#shares-empty').hidden = true;
    query('#share-pagination').hidden = true;
    list.setAttribute('aria-busy', 'true');
    try {
      const result = await api<{ shares: Share[]; page: number; hasMore: boolean }>(
        `/api/games/${encodeURIComponent(gameId)}/shares?page=${nextPage}`,
      );
      if (request !== listingRequest) return;
      page = result.page;
      list.replaceChildren();
      result.shares.forEach(renderShare);
      query('#shares-empty').hidden = result.shares.length > 0;
      query('#share-pagination').hidden = page === 1 && !result.hasMore;
      query('#current-page').textContent = `第 ${page} 页`;
      query<HTMLButtonElement>('#previous-page').disabled = page <= 1;
      query<HTMLButtonElement>('#next-page').disabled = !result.hasMore;
    } catch (error) {
      if (request !== listingRequest) return;
      list.replaceChildren();
      query('#shares-error').hidden = false;
      query('#shares-error-text').textContent = errorText(error);
    } finally {
      if (request === listingRequest) {
        query('#shares-loading').hidden = true;
        list.removeAttribute('aria-busy');
      }
    }
  }
  async function getConfig() {
    if (config) return config;
    if (!configPromise)
      configPromise = api<Config>('/api/config')
        .then((value) => {
          config = value;
          for (const provider of value.providers) providerNames[provider.id] = provider.label;
          return value;
        })
        .catch((error) => {
          configPromise = undefined;
          throw error;
        });
    return configPromise;
  }
  function setMessage(action: 'share' | 'report', text: string, error = false) {
    const el = query(`#${action}-form-message`);
    el.textContent = text;
    el.classList.toggle('error', error);
  }
  function updateSubmit(action: 'share' | 'report') {
    query<HTMLButtonElement>(`#submit-${action}`).disabled = !ready[action] || busy[action];
  }
  async function prepareForm(action: 'share' | 'report') {
    if (busy[action]) return;
    setMessage(action, '正在连接分享服务…');
    ready[action] = false;
    updateSubmit(action);
    try {
      const current = await getConfig();
      if (!current.submissionEnabled) throw new Error('社区投稿暂未开放，请稍后再试。');
      ready[action] = true;
      setMessage(action, '');
    } catch (error) {
      setMessage(action, errorText(error), true);
    } finally {
      updateSubmit(action);
    }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-open-share]').forEach((button) =>
    button.addEventListener('click', () => {
      shareDialog.showModal();
      void prepareForm('share');
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-close-dialog]').forEach((button) =>
    button.addEventListener('click', () => {
      button.closest('dialog')!.close();
    }),
  );
  for (const dialog of [shareDialog, reportDialog])
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        dialog.close();
    });
  shareForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!shareForm.reportValidity() || !ready.share || busy.share) return;
    busy.share = true;
    updateSubmit('share');
    setMessage('share', '正在发布…');
    const values = Object.fromEntries(new FormData(shareForm).entries());
    try {
      await api(`/api/games/${encodeURIComponent(gameId)}/shares`, values);
      shareForm.reset();
      shareDialog.close();
      announce('分享已发布，其他玩家现在可以看到你的链接。');
      await loadShares(1);
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      setMessage('share', errorText(error), true);
    } finally {
      busy.share = false;
      updateSubmit('share');
    }
  });
  reportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready.report || busy.report || !selectedReport) return;
    busy.report = true;
    updateSubmit('report');
    setMessage('report', '正在提交反馈…');
    try {
      await api(`/api/shares/${encodeURIComponent(selectedReport)}/reports`, {});
      reportDialog.close();
      announce('已记录失效反馈，谢谢。相同链接的重复反馈只计一次。');
      await loadShares(page);
    } catch (error) {
      setMessage('report', errorText(error), true);
    } finally {
      busy.report = false;
      updateSubmit('report');
    }
  });
  query('#retry-shares').addEventListener('click', () => void loadShares(page));
  query('#previous-page').addEventListener('click', () => void loadShares(Math.max(1, page - 1)));
  query('#next-page').addEventListener('click', () => void loadShares(page + 1));
  void loadShares();
}
