// core audio (wasapi) session control for mixer.ps1. every call re-enumerates endpoints so device switches never
// leave stale sessions. output escapes non-ascii so the console codepage cannot mangle it, and volumes are ints so
// locale cannot either.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace BridgeMixer {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    void GetCount(out int count);
    void Item(int index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    void GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    void GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    void GetCount(out int count);
    void GetSession(int index, out IAudioSessionControl2 session);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    void GetState(out int state);
    void GetDisplayName(out IntPtr name);
    void SetDisplayName(IntPtr name, IntPtr context);
    void GetIconPath(out IntPtr path);
    void SetIconPath(IntPtr path, IntPtr context);
    void GetGroupingParam(out Guid grouping);
    void SetGroupingParam(IntPtr grouping, IntPtr context);
    void RegisterAudioSessionNotification(IntPtr client);
    void UnregisterAudioSessionNotification(IntPtr client);
    void GetSessionIdentifier(out IntPtr id);
    void GetSessionInstanceIdentifier(out IntPtr id);
    void GetProcessId(out int pid);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    void SetMasterVolume(float level, ref Guid context);
    void GetMasterVolume(out float level);
    void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public static class Mixer {
    const int RENDER = 0, DEVICE_ACTIVE = 1, CLSCTX_ALL = 23, SESSION_EXPIRED = 2;

    static List<KeyValuePair<int, ISimpleAudioVolume>> Sessions() {
      var result = new List<KeyValuePair<int, ISimpleAudioVolume>>();
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDeviceCollection devices;
      enumerator.EnumAudioEndpoints(RENDER, DEVICE_ACTIVE, out devices);
      int deviceCount;
      devices.GetCount(out deviceCount);
      var iid = typeof(IAudioSessionManager2).GUID;
      for (var i = 0; i < deviceCount; i++) {
        try {
          IMMDevice device;
          devices.Item(i, out device);
          object activated;
          device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out activated);
          IAudioSessionEnumerator sessions;
          ((IAudioSessionManager2)activated).GetSessionEnumerator(out sessions);
          int count;
          sessions.GetCount(out count);
          for (var j = 0; j < count; j++) {
            IAudioSessionControl2 control;
            sessions.GetSession(j, out control);
            int state, pid;
            control.GetState(out state);
            control.GetProcessId(out pid);
            if (state == SESSION_EXPIRED || pid == 0) continue;
            result.Add(new KeyValuePair<int, ISimpleAudioVolume>(pid, (ISimpleAudioVolume)control));
          }
        } catch (Exception) {
          // one endpoint going away mid-enumeration should not hide the others
        }
      }
      return result;
    }

    static string Json(string value) {
      var builder = new StringBuilder("\"");
      foreach (var c in value) {
        if (c == '"' || c == '\\') builder.Append('\\').Append(c);
        else if (c < 32 || c > 126) builder.Append("\\u").Append(((int)c).ToString("x4"));
        else builder.Append(c);
      }
      return builder.Append('"').ToString();
    }

    static string List() {
      var names = new Dictionary<int, string>();
      var parts = new List<string>();
      foreach (var session in Sessions()) {
        string name;
        if (!names.TryGetValue(session.Key, out name)) {
          try { name = Process.GetProcessById(session.Key).ProcessName; } catch (Exception) { name = null; }
          names[session.Key] = name;
        }
        if (name == null) continue;
        float level;
        bool muted;
        session.Value.GetMasterVolume(out level);
        session.Value.GetMute(out muted);
        parts.Add("{\"pid\":" + session.Key + ",\"name\":" + Json(name) + ",\"volume\":" +
          (int)Math.Round(level * 100) + ",\"muted\":" + (muted ? "true" : "false") + "}");
      }
      return "{\"sessions\":[" + string.Join(",", parts) + "]}";
    }

    public static string Handle(string line) {
      try {
        var args = line.Split('\t');
        var context = Guid.Empty;
        if (args[0] == "set" || args[0] == "mute") {
          var pid = int.Parse(args[1], CultureInfo.InvariantCulture);
          foreach (var session in Sessions()) {
            if (session.Key != pid) continue;
            if (args[0] == "set") {
              session.Value.SetMasterVolume(int.Parse(args[2], CultureInfo.InvariantCulture) / 100f, ref context);
            } else {
              session.Value.SetMute(args[2] == "1", ref context);
            }
          }
          return "{\"ok\":true}";
        }
        return List();
      } catch (Exception error) {
        return "{\"error\":" + Json(error.Message) + "}";
      }
    }
  }
}
