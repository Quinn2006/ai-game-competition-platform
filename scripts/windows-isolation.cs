// Native Windows boundary. No shell, inherited environment, breakaway flag or
// running-before-job-assignment window. Compile with PowerShell Add-Type.
using System;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.ComponentModel;

public sealed class AgpJob : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,cbReserved;
    public IntPtr reserved2,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct CpuLimit { public uint flags,rate; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithLogonW(string user,string domain,string password,uint logon,string app,StringBuilder command,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  IntPtr job,process; public uint Pid {get;private set;}
  static void Check(bool ok) { if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error()); }
  void Set<T>(int kind,T value) {
    int size=Marshal.SizeOf(typeof(T)); IntPtr memory=Marshal.AllocHGlobal(size);
    try {Marshal.StructureToPtr(value,memory,false);Check(SetInformationJobObject(job,kind,memory,(uint)size));}
    finally {Marshal.FreeHGlobal(memory);}
  }
  public AgpJob(string exe,string arguments,string cwd,string[] environment,string user,string password,int memoryMb,int cpuPercent,int processes) {
    if(IntPtr.Size!=8 || memoryMb<64 || cpuPercent<1 || cpuPercent>100 || processes<1)throw new ArgumentException("Invalid job limits");
    job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
    ProcessInfo child=new ProcessInfo(); IntPtr env=IntPtr.Zero;
    try {
      // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS | JOB_MEMORY. No BREAKAWAY flags.
      Set(9,new ExtendedLimit{basic=new BasicLimit{flags=0x2000|0x8|0x200,activeProcesses=(uint)processes},jobMemory=(UIntPtr)((ulong)memoryMb*1024*1024)});
      Set(15,new CpuLimit{flags=1|4,rate=(uint)cpuPercent*100});
      env=Marshal.StringToHGlobalUni(string.Join("\0",environment.OrderBy(s=>s,StringComparer.OrdinalIgnoreCase))+"\0\0");
      var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup)),flags=1,show=0};
      var command=new StringBuilder("\""+exe+"\" "+arguments);
      uint flags=0x4|0x400|0x08000000; // SUSPENDED | UNICODE_ENVIRONMENT | NO_WINDOW
      bool ok=string.IsNullOrEmpty(user)?CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,flags,env,cwd,ref startup,out child):CreateProcessWithLogonW(user,".",password,0,exe,command,flags,env,cwd,ref startup,out child);
      Check(ok);Check(AssignProcessToJobObject(job,child.process));
      if(ResumeThread(child.thread)==0xffffffff)Check(false);
      process=child.process;Pid=child.pid;
    } catch {if(child.process!=IntPtr.Zero){TerminateProcess(child.process,1);CloseHandle(child.process);}Dispose();throw;}
    finally {if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);}
  }
  public bool Exited { get {return process==IntPtr.Zero || WaitForSingleObject(process,0)==0;} }
  public uint ExitCode { get {uint code;Check(GetExitCodeProcess(process,out code));return code;} }
  public void Dispose() {
    if(job!=IntPtr.Zero){TerminateJobObject(job,1);CloseHandle(job);job=IntPtr.Zero;}
    if(process!=IntPtr.Zero){WaitForSingleObject(process,5000);CloseHandle(process);process=IntPtr.Zero;}
  }
}

// Persistent ALE connect filters include loopback. Scoped to dedicated,
// administrator-owned executables. One-process jobs prevent helper escape.
public static class AgpNetwork {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Display { public string name,description; }
  [StructLayout(LayoutKind.Sequential)] struct Blob {public uint size;public IntPtr data;}
  [StructLayout(LayoutKind.Explicit,Size=16)] struct Value {
    [FieldOffset(0)] public uint type; [FieldOffset(8)] public IntPtr pointer;
    [FieldOffset(8)] public uint number;
  }
  [StructLayout(LayoutKind.Sequential)] struct Condition {public Guid key;public uint match;public Value value;}
  [StructLayout(LayoutKind.Sequential)] struct Action {public uint type;public Guid key;}
  [StructLayout(LayoutKind.Explicit,Size=16)] struct Context {[FieldOffset(0)] public ulong raw;}
  [StructLayout(LayoutKind.Sequential)] struct Filter {
    public Guid key;public Display display;public uint flags;public IntPtr provider;
    public Blob data;public Guid layer,sublayer;public Value weight;public uint count;
    public IntPtr conditions;public Action action;public Context context;public IntPtr reserved;
    public ulong id;public Value effectiveWeight;
  }
  [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmEngineOpen0(string server,uint auth,IntPtr identity,IntPtr session,out IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
  [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmGetAppIdFromFileName0(string file,out IntPtr id);
  [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr memory);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine,ref Filter filter,IntPtr sd,out ulong id);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine,ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetByKey0(IntPtr engine,ref Guid key,out IntPtr filter);
  static void Check(uint status) {if(status!=0)throw new Win32Exception((int)status);}
  static readonly Guid V4=new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"),V6=new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
  // FWP_MATCH_NOT_EQUAL = 10 (6 is FLAGS_ALL_SET, not inequality).
  static Condition Not(string key,uint type,uint value) {return new Condition{key=new Guid(key),match=10,value=new Value{type=type,number=value}};}
  static void Add(IntPtr engine,Guid key,Guid layer,Condition[] conditions) {
    int size=Marshal.SizeOf(typeof(Condition));IntPtr memory=Marshal.AllocHGlobal(size*conditions.Length);
    try {
      for(int i=0;i<conditions.Length;i++)Marshal.StructureToPtr(conditions[i],IntPtr.Add(memory,i*size),false);
      var filter=new Filter{key=key,display=new Display{name="AGP isolated runtime"},flags=1,layer=layer,
        sublayer=new Guid("eebecc03-ced4-4380-819a-2734397b2b74"),count=(uint)conditions.Length,conditions=memory,action=new Action{type=0x1001}};
      ulong id;Check(FwpmFilterAdd0(engine,ref filter,IntPtr.Zero,out id));
    }finally{Marshal.FreeHGlobal(memory);}
  }
  // Keys are pre-journaled by PowerShell, so interrupted installs are removable.
  public static void Install(string executable,int scannerPort,string[] keys) {
    if(keys.Length!=(scannerPort==0?2:4))throw new ArgumentException("Invalid filter keys");
    IntPtr engine=IntPtr.Zero,app=IntPtr.Zero;
    try {
      Check(FwpmEngineOpen0(null,10,IntPtr.Zero,IntPtr.Zero,out engine));Check(FwpmGetAppIdFromFileName0(executable,out app));
      var identity=new Condition{key=new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971"),value=new Value{type=12,pointer=app}};
      Add(engine,new Guid(keys[0]),V6,new[]{identity});
      if(scannerPort==0)Add(engine,new Guid(keys[1]),V4,new[]{identity});
      else {
        Add(engine,new Guid(keys[1]),V4,new[]{identity,Not("b235ae9a-1d64-49b8-a44c-5ff3d9095045",3,0x7f000001)});
        Add(engine,new Guid(keys[2]),V4,new[]{identity,Not("c35a604d-d22b-4e1a-91b4-68f674ee674b",2,(uint)scannerPort)});
        Add(engine,new Guid(keys[3]),V4,new[]{identity,Not("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7",1,6)});
      }
    }finally{if(app!=IntPtr.Zero)FwpmFreeMemory0(ref app);if(engine!=IntPtr.Zero)FwpmEngineClose0(engine);}
  }
  public static void Remove(string[] keys) {
    IntPtr engine;Check(FwpmEngineOpen0(null,10,IntPtr.Zero,IntPtr.Zero,out engine));
    try{foreach(string text in keys){Guid key=new Guid(text);uint status=FwpmFilterDeleteByKey0(engine,ref key);if(status!=0x80320003)Check(status);}}
    finally{FwpmEngineClose0(engine);}
  }
  public static void AssertInstalled(string[] keys) {
    IntPtr engine;Check(FwpmEngineOpen0(null,10,IntPtr.Zero,IntPtr.Zero,out engine));
    try{foreach(string text in keys){Guid key=new Guid(text);IntPtr memory;Check(FwpmFilterGetByKey0(engine,ref key,out memory));
      try{var filter=Marshal.PtrToStructure<Filter>(memory);if(filter.action.type!=0x1001 || (filter.flags&1)==0)throw new InvalidOperationException("Network filter changed");}
      finally{FwpmFreeMemory0(ref memory);}}}
    finally{FwpmEngineClose0(engine);}
  }
}
