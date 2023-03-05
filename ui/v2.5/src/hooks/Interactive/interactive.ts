export interface IFunscript {
  actions: Array<IAction>;
  inverted: boolean;
  range: number;
}

export interface IAction {
  at: number;
  pos: number;
}

// Utility function to convert one range of values to another
export function convertRange(
  value: number,
  fromLow: number,
  fromHigh: number,
  toLow: number,
  toHigh: number
) {
  return ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow) + toLow;
}

// Converting to CSV first instead of uploading Funscripts is required
// Reference for Funscript format:
// https://pkg.go.dev/github.com/funjack/launchcontrol/protocol/funscript
export function convertFunscriptToCSV(funscript: IFunscript) {
  const lineTerminator = "\r\n";
  if (funscript?.actions?.length > 0) {
    return funscript.actions.reduce((prev: string, curr: IAction) => {
      var { pos } = curr;
      // If it's inverted in the Funscript, we flip it because
      // the Handy doesn't have inverted support
      if (funscript.inverted === true) {
        pos = convertRange(curr.pos, 0, 100, 100, 0);
      }
      // in APIv2; the Handy maintains it's own slide range
      // (ref: https://staging.handyfeeling.com/api/handy/v2/docs/#/SLIDE )
      // so if a range is specified in the Funscript, we convert it to the
      // full range and let the Handy's settings take precedence
      if (funscript.range) {
        pos = convertRange(curr.pos, 0, funscript.range, 0, 100);
      }
      return `${prev}${curr.at},${pos}${lineTerminator}`;
    }, `#Created by stash.app ${new Date().toUTCString()}\n`);
  }
  throw new Error("Not a valid funscript");
}

export interface IInteractive {
  scriptOffset: number;
  enabled(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  uploadScript(funscriptPath: string): Promise<void>;
  sync(): Promise<number>;
  setServerTimeOffset(offset: number): void;
  play(position: number): Promise<void>;
  pause(): Promise<void>;
  ensurePlaying(position: number): Promise<void>;
  setLooping(looping: boolean): Promise<void>;
}

export class FunscriptPlayer {
  _callback: (pos: number) => Promise<void>;
  _funscript: IFunscript | undefined;
  _offset: number;
  _hzRate: number;
  _timeoutId: any | undefined;
  _paused: boolean = true;
  _currTime: number = 0;
  _currAt: number = 0;
  _lastTime: number = 0;
  _lastAt: number = 0;

  constructor(
    callback: (pos: number) => Promise<void>,
    offset: number = 0,
    hzRate: number = 60
  ) {
    this._callback = callback;
    this._offset = offset;
    this._hzRate = hzRate;
  }

  set funscript(json: IFunscript | undefined) {
    this._funscript = json;
    this.pause();
  }

  set callback(callback: (pos: number) => Promise<void>) {
    this._callback = callback;
  }

  set offset(val: number) {
    this._offset = val;
  }

  set hzRate(hz: number) {
    this._hzRate = hz;
  }

  play(at: number = 0) {
    if (!this._funscript) {
      return;
    }
    this.cancelLoop();
    this._paused = false;

    this._lastTime = this._currTime = Date.now();
    this._lastAt = this._currAt = at;

    this.runLoop();
  }

  playSync(at: number) {
    this._lastTime = this._currTime;
    this._lastAt = this._currAt;
    this._currTime = Date.now();
    this._currAt = at;
  }

  pause() {
    this._paused = true;
    this.cancelLoop();
  }

  private cancelLoop() {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = undefined;
    }
  }

  /**
   * Calculates the current frame's funscript "at" time based on synced play time
   */
  private nextAt(now: number) {
    const nowTimeDelta = now - this._currTime; // ms since last sync frame
    const lastTimeDelta = this._currTime - this._lastTime;
    const lastAtDelta = this._currAt - this._lastAt;
    if (lastTimeDelta === 0 || lastAtDelta === 0) {
      return this._currAt + nowTimeDelta; // with no history, assume playback rate of 1x
    }
    return this._currAt + convertRange(nowTimeDelta, 0, lastTimeDelta, 0, lastAtDelta);
  }

  private runLoop() {
    this._timeoutId = setTimeout(() => {
      if (this._paused) {
        return;
      }

      const currAt = this.nextAt(Date.now());
      console.log(`Funscript at: ${currAt}`);
      // TODO: Lookup and queue actions to send
      this._callback(0); // TODO

      this.runLoop();
    }, 1000 / this._hzRate);
  }
}

// Interactive currently uses the Handy API, but could be expanded to use buttplug.io
// via buttplugio/buttplug-rs-ffi's WASM module.
export class HandyInteractive implements IInteractive {
  _connected: boolean;
  _playing: boolean;
  _scriptOffset: number;
  _handy: Handy;
  _useStashHostedFunscript: boolean;

  constructor(scriptOffset: number = 0) {
    this._handy = new Handy();
    this._scriptOffset = scriptOffset;
    this._useStashHostedFunscript = false;
    this._connected = false;
    this._playing = false;
  }

  enabled(): boolean {
    return (this._handy.connectionKey !== "");
  }

  async connect() {
    const connected = await this._handy.getConnected();
    if (!connected) {
      throw new Error("Handy not connected");
    }

    // check the firmware and make sure it's compatible
    const info = await this._handy.getInfo();
    if (info.fwStatus === HandyFirmwareStatus.updateRequired) {
      throw new Error("Handy firmware update required");
    }
  }

  set handyKey(key: string) {
    this._handy.connectionKey = key;
  }

  get handyKey(): string {
    return this._handy.connectionKey;
  }

  set useStashHostedFunscript(useStashHostedFunscript: boolean) {
    this._useStashHostedFunscript = useStashHostedFunscript;
  }

  get useStashHostedFunscript(): boolean {
    return this._useStashHostedFunscript;
  }

  set scriptOffset(offset: number) {
    this._scriptOffset = offset;
  }

  async uploadScript(funscriptPath: string, apiKey?: string) {
    if (!(this._handy.connectionKey && funscriptPath)) {
      return;
    }

    var funscriptUrl;

    if (this._useStashHostedFunscript) {
      funscriptUrl = funscriptPath.replace("/funscript", "/interactive_csv");
      if (typeof apiKey !== "undefined" && apiKey !== "") {
        var url = new URL(funscriptUrl);
        url.searchParams.append("apikey", apiKey);
        funscriptUrl = url.toString();
      }
    } else {
      const csv = await fetch(funscriptPath)
        .then((response) => response.json())
        .then((json) => convertFunscriptToCSV(json));
      const fileName = `${Math.round(Math.random() * 100000000)}.csv`;
      const csvFile = new File([csv], fileName);

      funscriptUrl = await uploadCsv(csvFile).then((response) => response.url);
    }

    await this._handy.setMode(HandyMode.hssp);

    this._connected = await this._handy
      .setHsspSetup(funscriptUrl)
      .then((result) => result === HsspSetupResult.downloaded);
  }

  async sync() {
    return this._handy.getServerTimeOffset();
  }

  setServerTimeOffset(offset: number) {
    this._handy.estimatedServerTimeOffset = offset;
  }

  async play(position: number) {
    if (!this._connected) {
      return;
    }

    this._playing = await this._handy
      .setHsspPlay(
        Math.round(position * 1000 + this._scriptOffset),
        this._handy.estimatedServerTimeOffset + Date.now() // our guess of the Handy server's UNIX epoch time
      )
      .then(() => true);
  }

  async pause() {
    if (!this._connected) {
      return;
    }
    this._playing = await this._handy.setHsspStop().then(() => false);
  }

  async ensurePlaying(position: number) {
    if (this._playing) {
      return;
    }
    await this.play(position);
  }

  async setLooping(looping: boolean) {
    if (!this._connected) {
      return;
    }
    this._handy.setHsspLoop(looping);
  }
}

export class ButtplugInteractive implements IInteractive {
  _scriptOffset: number;

  constructor(scriptOffset: number = 0) {
    this._scriptOffset = scriptOffset;
  }

  enabled(): boolean {
    return true;
  }

  async connect() {
    const connector = new ButtplugBrowserWebsocketClientConnector("ws://localhost:12345");
    const client = new ButtplugClient("Device Control Example");
    client.addListener(
      "deviceadded",
      async (device: ButtplugClientDevice) => {
        console.log(`Device Connected: ${device.name}`);
        //devices.current.push(device);
        // setDeviceDatas((deviceDatas) => [
        //   ...deviceDatas,
        //   {
        //     intensities: { vibration: 0, rotation: 0 },
        //   },
        // ]);
      }
    );
    client.addListener("deviceremoved", (device) =>
      console.log(`Device Removed: ${device.name}`)
    );
    await client.connect(connector);
    await client.startScanning();
  }

  set scriptOffset(offset: number) {
    this._scriptOffset = offset;
  }

  async uploadScript(funscriptPath: string) {
    if (!funscriptPath) {
      return;
    }

    const csv = await fetch(funscriptPath)
      .then((response) => response.json())
      .then((json) => convertFunscriptToCSV(json));
    const fileName = `${Math.round(Math.random() * 100000000)}.csv`;
    const csvFile = new File([csv], fileName);
    return;
  }

  async sync() {
    return 0;
  }

  setServerTimeOffset(offset: number) {
    return;
  }

  async play(position: number) {
    return;
  }

  async pause() {
    return;
  }

  async ensurePlaying(position: number) {
    return;
  }

  async setLooping(looping: boolean) {
    return;
  }
}
