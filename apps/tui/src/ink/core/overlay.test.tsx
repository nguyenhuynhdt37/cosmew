/** @jsxImportSource react */
import {expect, test} from 'bun:test';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {OverlayProvider, useOverlay, type OverlayRouter} from './overlay';

test('OverlayProvider preserves background panels across multiple replaced modals and rapid pushes', async () => {
  let router!: OverlayRouter;
  function Probe() {
    router = useOverlay();
    return <Text>{router.active ? `active:${router.active.id}` : 'active:none'}</Text>;
  }
  const app = render(
    <OverlayProvider>
      <Probe />
    </OverlayProvider>,
  );
  const flush = async () => {
    await Bun.sleep(5);
  };
  try {
    expect(app.lastFrame()).toBe('active:none');

    // Open a normal panel, push modal 1, replace with modal 2, then close -> background panel returns.
    router.open('settings', <Text>settings</Text>);
    await flush();
    expect(app.lastFrame()).toBe('active:settings');

    router.push('permission:p1', <Text>p1</Text>);
    router.replace('permission:p2', <Text>p2</Text>);
    await flush();
    expect(app.lastFrame()).toBe('active:permission:p2');

    router.close();
    await flush();
    expect(app.lastFrame()).toBe('active:settings');

    // Two synchronous pushes in the same tick keep both entries in order on the stack.
    router.push('question:q1', <Text>q1</Text>);
    router.push('permission:p3', <Text>p3</Text>);
    await flush();
    expect(app.lastFrame()).toBe('active:permission:p3');

    router.close();
    await flush();
    expect(app.lastFrame()).toBe('active:question:q1');

    router.close();
    await flush();
    expect(app.lastFrame()).toBe('active:settings');

    router.close();
    await flush();
    expect(app.lastFrame()).toBe('active:none');
  } finally {
    app.unmount();
  }
});
