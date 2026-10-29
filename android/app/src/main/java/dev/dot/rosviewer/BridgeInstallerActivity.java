package dev.dot.rosviewer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.jcraft.jsch.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Native, explicitly authorized SSH setup. No WebView command API or persisted credentials. */
public final class BridgeInstallerActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private volatile Session session;
    private volatile ChannelExec channel;
    private volatile CountDownLatch hostDecision;
    private AlertDialog hostDialog;
    private EditText host, port, username, password, sudoPassword, privateKey, keyPassphrase;
    private CheckBox keyAuth;
    private Button importKey;
    private String installToken;
    private BridgePackagePlan plan;
    private boolean bridgeInstalled;
    private volatile ChannelSftp transfer;
    private Button detect, download, install, cancel, connectViewer;
    private String viewerEndpoint;
    private File packageCache;
    private java.util.List<File> downloadedFiles;
    private String planTarget;
    private TextView status, log;
    private volatile boolean busy, destroyed;
    private boolean detected;
    private byte[] pinnedKey;
    private String pinnedTarget;
    private String script;
    private final StringBuilder logBuffer = new StringBuilder();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // Previous process death may leave only public package bytes, never credentials.
        File[] stale=getCacheDir().listFiles();
        if(stale!=null)for(File f:stale)if(f.getName().matches("bridge-[a-f0-9]{32}"))deleteCache(f);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        int p = (int)(16 * getResources().getDisplayMetrics().density);
        body.setPadding(p,p,p,p);
        ScrollView scroll = new ScrollView(this); scroll.addView(body); setContentView(scroll);
        text(body, "安装 ROS1 Foxglove bridge", 22);
        text(body, "输入目标 IP 和 SSH 用户名，使用密码或私钥登录。凭据仅本次内存使用，不会上传到我们的服务器；密码只通过加密 SSH 发送给你指定的主机，私钥保留在手机。下载由手机网络完成，安装/启动前再次确认。", 14);
        host = field(body, "ROS 主机 IP / 域名", "", false);
        port = field(body, "SSH 端口", "22", false); port.setInputType(InputType.TYPE_CLASS_NUMBER);
        username = field(body, "非 root 用户名", "", false);
        password = field(body, "SSH 密码（仅本次内存使用）", "", true);
        keyAuth = new CheckBox(this); keyAuth.setText("使用私钥登录（OpenSSH / PEM）"); body.addView(keyAuth);
        privateKey = field(body, "粘贴私钥，或选择私钥文件", "", true);
        privateKey.setSingleLine(false); privateKey.setTransformationMethod(android.text.method.PasswordTransformationMethod.getInstance()); privateKey.setMinLines(2); privateKey.setMaxLines(4); privateKey.setEnabled(false);
        keyPassphrase = field(body, "私钥口令（未加密私钥可留空）", "", true); keyPassphrase.setEnabled(false);
        importKey = button(body, "选择私钥文件"); importKey.setEnabled(false);
        importKey.setOnClickListener(v -> {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT); pick.setType("*/*"); pick.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(pick, 71);
        });
        keyAuth.setOnCheckedChangeListener((button,checked)->{
            password.setEnabled(!checked); privateKey.setEnabled(checked); keyPassphrase.setEnabled(checked); importKey.setEnabled(checked);
            if (checked) password.setText(""); else {privateKey.setText("");keyPassphrase.setText("");}
        });
        sudoPassword = field(body, "sudo 密码（安装时需要；免密 sudo 可留空）", "", true);
        detect = button(body, "连接并检测");
        download = button(body, "仅手机下载 DEB / 重试下载"); download.setEnabled(false);
        install = button(body, "上传并安装 bridge"); install.setEnabled(false);
        cancel = button(body, "取消当前操作 / 断开"); cancel.setEnabled(false);
        connectViewer = button(body, "返回查看器并连接"); connectViewer.setEnabled(false);
        connectViewer.setOnClickListener(v -> {
            if(viewerEndpoint==null)return;
            Intent result=new Intent();result.putExtra("bridge_endpoint",viewerEndpoint);setResult(RESULT_OK,result);finish();
        });
        Button back = button(body, "返回查看器");
        status = text(body, "尚未连接。首次连接请向主机管理员核对 SHA256 主机密钥指纹。", 14);
        log = text(body, "", 12); log.setTextIsSelectable(true);
        detect.setOnClickListener(v -> connectAndProbe());
        download.setOnClickListener(v -> confirmDownload());
        install.setOnClickListener(v -> { if (bridgeInstalled) confirmStart(); else confirmInstall(); });
        cancel.setOnClickListener(v -> cancelWork("已取消并断开。若正在安装，远端状态可能未定，请重新检测；不会自动重试。"));
        back.setOnClickListener(v -> onBackPressed());
        try (InputStream in = getAssets().open("bridge-installer.sh")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] b = new byte[4096]; int n;
            while ((n=in.read(b)) != -1) out.write(b,0,n);
            script = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (IOException e) { detect.setEnabled(false); status.setText("安装资源缺失，无法运行。"); }
    }
    private TextView text(LinearLayout body, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); body.addView(view); return view;
    }
    private EditText field(LinearLayout body, String hint, String value, boolean secret) {
        EditText view = new EditText(this); view.setHint(hint); view.setText(value); view.setSingleLine(true);
        view.setSaveEnabled(false); view.setFreezesText(false);
        view.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD));
        if (android.os.Build.VERSION.SDK_INT >= 26) view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        body.addView(view); return view;
    }
    private Button button(LinearLayout body, String value) {
        Button view = new Button(this); view.setText(value); body.addView(view); return view;
    }
    private void setBusy(boolean value) {
        busy=value;
        if(!value && session!=null && !session.isConnected())disconnect();
        detect.setEnabled(!value && session == null);
        download.setEnabled(!value && plan!=null && !bridgeInstalled);
        install.setEnabled(!value && detected && (bridgeInstalled || downloadedFiles!=null) && session != null && session.isConnected());
        cancel.setEnabled(value || session != null);
        host.setEnabled(!value && session == null); port.setEnabled(!value && session == null);
        username.setEnabled(!value && session == null); password.setEnabled(!value && session == null && !keyAuth.isChecked());
        keyAuth.setEnabled(!value && session==null); privateKey.setEnabled(!value && session==null && keyAuth.isChecked());
        keyPassphrase.setEnabled(!value && session==null && keyAuth.isChecked()); importKey.setEnabled(!value && session==null && keyAuth.isChecked());
        sudoPassword.setEnabled(!value && !bridgeInstalled);
    }
    private void connectAndProbe() {
        if (busy) return;
        final String h, u; final int p;
        try { h=InstallerPolicy.host(host.getText().toString()); u=InstallerPolicy.user(username.getText().toString()); p=InstallerPolicy.port(port.getText().toString()); }
        catch (IllegalArgumentException e) { status.setText(e.getMessage()); return; }
        final boolean useKey=keyAuth.isChecked();
        if ((!useKey && password.length()==0) || (useKey && privateKey.length()==0)) { status.setText("请输入 SSH 密码或私钥。交互式 MFA 暂不支持。"); return; }
        if (privateKey.length()>65536) {status.setText("私钥文件过大（限制 64 KB）。");return;}
        final byte[] identity=useKey ? privateKey.getText().toString().getBytes(StandardCharsets.UTF_8) : null;
        final byte[] passphrase=useKey ? keyPassphrase.getText().toString().getBytes(StandardCharsets.UTF_8) : null;
        privateKey.setText("");keyPassphrase.setText("");
        byte[] secret=password.getText().toString().getBytes(StandardCharsets.UTF_8); password.setText("");
        disconnect(); detected=false; viewerEndpoint=null;connectViewer.setEnabled(false);logBuffer.setLength(0); log.setText("");
        int token=generation.incrementAndGet(); setBusy(true); status.setText("正在连接 SSH 并核对主机身份…");
        worker.execute(() -> {
            JSch jsch = new JSch(); Session owned=null; boolean retain=false;
            try {
                check(token);
                if(useKey) jsch.addIdentity("one-time-mobile-key", identity, null, passphrase);
                String target=h+":"+p;
                jsch.setHostKeyRepository(new HostKeyRepository() {
                    public int check(String ignored, byte[] key) {
                        if (pinnedKey != null && target.equals(pinnedTarget))
                            return MessageDigest.isEqual(pinnedKey,key) ? OK : CHANGED;
                        if (!confirmHost(target,key,token)) return NOT_INCLUDED;
                        pinnedTarget=target; pinnedKey=key.clone(); return OK;
                    }
                    public void add(HostKey k, UserInfo u) {}
                    public void remove(String h, String type) {}
                    public void remove(String h, String type, byte[] key) {}
                    public String getKnownHostsRepositoryID() { return "Session-only verified host"; }
                    public HostKey[] getHostKey() { return new HostKey[0]; }
                    public HostKey[] getHostKey(String h, String type) { return new HostKey[0]; }
                });
                Session next = jsch.getSession(u,h,p); owned=next; check(token); session=next; check(token);
                next.setConfig("StrictHostKeyChecking","yes");
                next.setConfig("PreferredAuthentications",useKey ? "publickey" : "password");
                // Android API24's standard crypto providers support these modern algorithms.
                // No ssh-rsa/SHA1 or host-key checking downgrade on negotiation failure.
                next.setConfig("server_host_key","ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256");
                next.setConfig("kex","ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group14-sha256");
                next.setConfig("cipher.c2s","aes128-ctr,aes256-ctr"); next.setConfig("cipher.s2c","aes128-ctr,aes256-ctr");
                next.setConfig("mac.c2s","hmac-sha2-256,hmac-sha2-512"); next.setConfig("mac.s2c","hmac-sha2-256,hmac-sha2-512");
                next.setPassword(secret); next.setServerAliveInterval(15000); next.setServerAliveCountMax(3);
                next.connect(20000); next.setPassword((byte[])null); jsch.removeAllIdentity();
                check(token); append("SSH 身份验证成功。开始只读检测。\n",token);
                Result probe=run("probe",null,token,120000);
                if(probe.exit!=0) throw new IOException("Unsupported host or probe failure");
                bridgeInstalled=probe.output.contains("\nBRIDGE_INSTALLED\n") || probe.output.startsWith("BRIDGE_INSTALLED\n");
                installToken=java.util.UUID.randomUUID().toString().replace("-", "");
                if(!bridgeInstalled) {
                    append("bridge 未安装，检查系统版本、架构并取得已认证 APT 下载计划…\n",token);
                    Result planned=run("plan",null,token,120000);
                    if(planned.exit!=0)throw new IOException("Package plan failed");
                    BridgePackagePlan nextPlan=BridgePackagePlan.parse(planned.output);
                    String nextTarget=u+"@"+h+":"+p;
                    if(!nextTarget.equals(planTarget) || !samePlan(plan,nextPlan)) {
                        deleteCache(packageCache);downloadedFiles=null;
                        packageCache=new File(getCacheDir(),"bridge-"+installToken);
                    }
                    plan=nextPlan;planTarget=nextTarget;
                }
                retain=true;
                ui(token, () -> {
                    detected=true;
                    install.setText(bridgeInstalled ? "启动已安装的 bridge" : "上传并安装 bridge");
                    status.setText(bridgeInstalled ? "已检测到 bridge。可确认启动只读服务。" : "下载计划就绪："+plan.packages.size()+" 个包，"+((plan.totalBytes+1048575)/1048576)+" MB。"+(downloadedFiles!=null ? "已核对原下载清单，可用已校验缓存上传安装。" : "先点击仅手机下载。可切换移动网络下载，再回目标 Wi-Fi 重连上传。"));
                    setBusy(false);
                });
            } catch (Exception e) { failed(token,"连接/检测",e); }
            finally {
                Arrays.fill(secret,(byte)0); if(identity!=null)Arrays.fill(identity,(byte)0);if(passphrase!=null)Arrays.fill(passphrase,(byte)0);
                try{jsch.removeAllIdentity();}catch(JSchException ignored){}
                if(owned!=null){owned.setPassword((byte[])null);if(!retain || destroyed){owned.disconnect();if(session==owned)session=null;}}
            }
        });
    }
    private boolean confirmHost(String target, byte[] key, int token) {
        final String fingerprint;
        try { fingerprint="SHA256:"+Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(key),Base64.NO_WRAP|Base64.NO_PADDING); }
        catch (Exception e) { return false; }
        CountDownLatch latch=new CountDownLatch(1); hostDecision=latch; final boolean[] accepted={false};
        if(destroyed || generation.get()!=token){hostDecision=null;return false;}
        ui(token, () -> hostDialog=new AlertDialog.Builder(this).setTitle("核对 SSH 主机身份")
            .setMessage(target+"\n\n"+fingerprint+"\n\n请通过主机管理员或主机本机可信渠道核对。未核对不要继续。只在当前安装页面内记住此密钥，关闭后清除。")
            .setPositiveButton("已核对，继续",(d,w)->{accepted[0]=true;latch.countDown();})
            .setNegativeButton("拒绝",(d,w)->latch.countDown()).setOnCancelListener(d->latch.countDown()).show());
        try { return latch.await(120,TimeUnit.SECONDS) && accepted[0] && generation.get()==token; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        finally { hostDecision=null; ui(token,()->{if(hostDialog!=null)hostDialog.dismiss();hostDialog=null;}); }
    }
    private static boolean samePlan(BridgePackagePlan a,BridgePackagePlan b) {
        if(a==null || b==null || a.packages.size()!=b.packages.size())return false;
        java.util.Map<String,String> values=new java.util.HashMap<>();
        for(BridgePackagePlan.Entry e:a.packages)values.put(e.name,e.sha256+":"+e.size);
        for(BridgePackagePlan.Entry e:b.packages)if(!(e.sha256+":"+e.size).equals(values.get(e.name)))return false;
        return true;
    }
    private void confirmDownload() {
        if(busy || plan==null)return;
        new AlertDialog.Builder(this).setTitle("仅下载到手机")
            .setMessage("目标清单："+planTarget+"\n"+plan.packages.size()+" 个包，约 "+((plan.totalBytes+1048575)/1048576)+" MB。下载不需要 SSH 保持连接。Wi-Fi 失败时可手动切换移动网络后重试；下载成功后切回主机 Wi-Fi，重新登录核对清单再安装。可能产生移动流量费用。")
            .setPositiveButton("下载",(d,w)->downloadPackages()).setNegativeButton("取消",null).show();
    }
    private void downloadPackages() {
        if(busy || plan==null)return;
        int token=generation.incrementAndGet();setBusy(true);status.setText("手机正在下载；无需 SSH 在线。已成功校验的包会保留供切网重试。");
        worker.execute(()->{
            try {
                java.util.List<File> files=BridgeDownloader.download(plan,packageCache,
                    (message,done,total)->ui(token,()->status.setText(message+" "+done+" / "+total+" 字节")),
                    ()->destroyed || generation.get()!=token);
                ui(token,()->{downloadedFiles=files;setBusy(false);status.setText(session!=null && session.isConnected() ? "手机下载及校验完成，可以上传并安装。" : "手机下载及校验完成。请切回目标主机 Wi-Fi，重新输入一次性凭据，连接并检测后上传安装。");});
            }catch(Exception e){ui(token,()->{setBusy(false);status.setText("手机下载未完成："+safeDownloadError(e)+"。已校验的完整包保留。若是 Wi-Fi 网络不可达，可手动切换移动网络后点‘仅手机下载 / 重试下载’，无需先连 SSH。");});}
            finally{if(destroyed)deleteCache(packageCache);}
        });
    }
    private void confirmInstall() {
        if (busy || !detected || plan==null || downloadedFiles==null || session==null || !session.isConnected()) return;
        new AlertDialog.Builder(this).setTitle("上传并安装到这台主机？")
            .setMessage("目标："+session.getUserName()+"@"+session.getHost()+":"+session.getPort()
                +"\n将手机上已校验的 DEB 包通过 SSH 传送并以 sudo 安装。不会修改软件源或防火墙。安装后另行确认启动只读 bridge。\n请勿在运行关键任务时安装。")
            .setPositiveButton("上传并安装",(d,w)->startInstall()).setNegativeButton("取消",null).show();
    }
    private void startInstall() {
        if (busy || !detected || plan==null || downloadedFiles==null) return;
        final byte[] sudo = (sudoPassword.getText().toString()+"\n").getBytes(StandardCharsets.UTF_8);
        sudoPassword.setText("");int token=generation.incrementAndGet();setBusy(true);status.setText("正在重新校验缓存并上传到主机…");
        worker.execute(() -> {
            String stage="上传";
            try {
                for(BridgePackagePlan.Entry e:plan.packages)
                    if(!BridgeDownloader.verifiedFile(new File(packageCache,e.name),e))throw new IOException("Cached package verification failed");
                check(token);append("缓存校验完成，正在通过 SSH 传送。\n",token);
                ChannelSftp sftp=(ChannelSftp)session.openChannel("sftp");transfer=sftp;
                try {
                    sftp.connect(15000);
                    String remote=sftp.getHome()+"/.cache/pocket-rviz-installer/"+installToken;
                    for(BridgePackagePlan.Entry e:plan.packages) {
                        check(token);sftp.put(new File(packageCache,e.name).getAbsolutePath(),remote+"/"+e.name);
                    }
                } finally {sftp.disconnect();if(transfer==sftp)transfer=null;}
                stage="安装";append("传送完成，开始 sudo 安装。为避免泄露密码，此步骤不显示远端原始输出。\n",token);
                Result result=run("install",sudo,token,900000);
                if(result.exit!=0)throw new StepException(result.exit);
                ui(token,()->{bridgeInstalled=true;detected=true;install.setText("启动已安装的 bridge");status.setText("DEB 安装完成。请确认启动只读 bridge。");setBusy(false);confirmStart();});
            } catch(Exception e) {
                final String failedStage=stage;
                ui(token,()->{disconnect();detected=false;setBusy(false);status.setText(failedStage+"未完成（"+(e instanceof StepException ? "远端退出码 "+((StepException)e).code : e.getClass().getSimpleName())+"）。远端可能已有部分结果。下载缓存保留，请重新登录检测后再决定是否重试，不会自动重复安装。");});
            } finally {Arrays.fill(sudo,(byte)0);if(destroyed)deleteCache(packageCache);}
        });
    }
    private void confirmStart() {
        if(busy || !bridgeInstalled || session==null || !session.isConnected())return;
        new AlertDialog.Builder(this).setTitle("启动只读 bridge？")
            .setMessage("将在 SSH 连接所到达的主机网卡地址监听 8765。禁用发布、参数修改和服务调用，但同网段能连接此端口的设备可读取 ROS 话题。仅在可信隔离网络继续；不创建开机自启、不改防火墙。ROS master 必须已在运行。")
            .setPositiveButton("启动",(d,w)->startBridge()).setNegativeButton("稍后",null).show();
    }
    private void startBridge() {
        if(busy || session==null || !session.isConnected())return;
        final String connectedHost=session.getHost();
        int token=generation.incrementAndGet();setBusy(true);status.setText("正在启动并检查 bridge…");
        worker.execute(()->{
            try {
                Result result=run("start",null,token,60000);
                ui(token,()->{
                    if(result.exit==0) {
                        String endpoint="ws://"+(connectedHost.indexOf(':')>=0 ? "["+connectedHost+"]" : connectedHost)+":8765";
                        try {viewerEndpoint=DiagnosticEndpoint.parse(endpoint).target;connectViewer.setEnabled(true);}catch(IllegalArgumentException ignored){}
                    }
                    status.setText(result.exit==0 ? "主机端 Foxglove 握手与只读配置已验证。请按日志地址返回查看器，确认手机可达和话题接收；服务保留在主机运行。" : "启动未完成（退出码 "+result.exit+"）。请检查 ROS master、端口占用和下方日志。");disconnect();detected=false;setBusy(false);});
            }catch(Exception e){failed(token,"启动",e);}
        });
    }
    private static void deleteCache(File root) {
        if(root==null)return;
        File[] files=root.listFiles();if(files!=null)for(File f:files)if(f.isFile())f.delete();root.delete();
    }
    private static final class StepException extends IOException {
        final int code;StepException(int code){this.code=code;}
    }
    private static final class Result {
        final int exit;final String output;Result(int code,String stdout){exit=code;output=stdout;}
    }
    private Result run(String mode, byte[] stdin, int token, long timeout) throws Exception {
        check(token); Session active=session;if(active==null || !active.isConnected())throw new IOException("SSH disconnected");
        ChannelExec exec=(ChannelExec)active.openChannel("exec");channel=exec;
        exec.setPty(false);exec.setCommand(InstallerPolicy.command(script,mode,installToken));
        exec.setInputStream(new ByteArrayInputStream(stdin==null ? new byte[0] : stdin));
        InputStream out=exec.getInputStream(),err=exec.getErrStream();
        ByteArrayOutputStream captured=new ByteArrayOutputStream();
        long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeout);
        try {
            exec.connect(15000);byte[] buffer=new byte[2048];
            while(true) {
                check(token);drain(out,buffer,token,stdin,captured);drain(err,buffer,token,stdin,null);
                if(exec.isClosed()){drain(out,buffer,token,stdin,captured);drain(err,buffer,token,stdin,null);return new Result(exec.getExitStatus(),new String(captured.toByteArray(),StandardCharsets.UTF_8));}
                if(System.nanoTime()>deadline)throw new IOException("operation timed out");
                Thread.sleep(100);
            }
        }finally{exec.disconnect();if(channel==exec)channel=null;}
    }
    private void drain(InputStream in,byte[] buffer,int token,byte[] secret,ByteArrayOutputStream captured) throws IOException {
        int batch=0;
        while(in.available()>0 && batch<65536) {
            if(destroyed || generation.get()!=token)throw new IOException("Canceled");
            int n=in.read(buffer,0,Math.min(buffer.length,in.available()));if(n<=0)return;
            batch+=n;
            if(secret!=null)continue;
            if(captured!=null){if(captured.size()+n>1024*1024)throw new IOException("Remote output exceeded limit");captured.write(buffer,0,n);}
            append(new String(buffer,0,n,StandardCharsets.UTF_8),token);
        }
    }
    private void append(String value,int token) {
        final String clean=InstallerPolicy.cleanLog(value);
        ui(token,()->{logBuffer.append(clean);if(logBuffer.length()>24000)logBuffer.delete(0,logBuffer.length()-24000);log.setText(logBuffer.toString());});
    }
    private void check(int token) throws InterruptedException { if(destroyed || token!=generation.get() || Thread.currentThread().isInterrupted())throw new InterruptedException(); }
    private void ui(int token,Runnable action) {runOnUiThread(()->{if(!destroyed && generation.get()==token)action.run();});}
    private static String safeDownloadError(Exception error) {
        if(error instanceof javax.net.ssl.SSLException)return "HTTPS 证书或 TLS 验证失败，未忽略证书";
        if(error instanceof java.net.UnknownHostException)return "域名解析失败";
        if(error instanceof java.net.SocketTimeoutException)return "网络连接或读取超时";
        String message=error.getMessage();
        if(message!=null)for(String prefix:new String[]{"软件包 SHA-256", "软件包大小", "软件包超出", "官方软件源返回 HTTP", "下载重定向", "拒绝从 HTTPS", "软件包地址不是", "无法创建临时", "无法保存下载", "无法替换临时"})
            if(message.startsWith(prefix) && message.length()<150)return message;
        return error.getClass().getSimpleName();
    }
    private static String safeConnectionError(Exception error) {
        String message=error.getMessage();
        if(error instanceof JSchException && message!=null) {
            if(message.contains("Auth fail"))return "SSH 身份验证失败，请检查密码或私钥/口令";
            if(message.contains("HostKey") || message.contains("hostkey"))return "主机密钥未获确认或已变化，未继续认证";
            if(message.contains("Algorithm negotiation"))return "SSH 算法不兼容，未降级安全算法";
            if(message.contains("invalid privatekey"))return "无法解析私钥，请检查格式及口令";
        }
        return error.getClass().getSimpleName();
    }
    private void failed(int token,String phase,Exception error) {
        // Exception strings may contain remote text; do not log them or authentication material.
        ui(token,()->{disconnect();detected=false;status.setText(phase+"未完成。检查网络、用户名/密码、主机指纹和服务器 SSH 配置。安装若已开始，远端状态可能未定，请重新检测。错误类型："+safeConnectionError(error));setBusy(false);});
    }
    private void disconnect() { ChannelSftp f=transfer;transfer=null;if(f!=null)f.disconnect();ChannelExec c=channel;channel=null;if(c!=null)c.disconnect();Session s=session;session=null;if(s!=null)s.disconnect(); }
    private void cancelWork(String message) {
        generation.incrementAndGet();CountDownLatch latch=hostDecision;if(latch!=null)latch.countDown();
        if(hostDialog!=null)hostDialog.dismiss();hostDialog=null;disconnect();detected=false;
        password.setText("");sudoPassword.setText("");privateKey.setText("");keyPassphrase.setText("");status.setText(message);setBusy(false);
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request!=71 || result!=RESULT_OK || data==null || data.getData()==null) return;
        try(InputStream in=getContentResolver().openInputStream(data.getData())) {
            if(in==null)throw new IOException(); ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] bytes=new byte[4096];int n;
            while((n=in.read(bytes))!=-1) {out.write(bytes,0,n);if(out.size()>65536)throw new IOException();}
            privateKey.setText(new String(out.toByteArray(),StandardCharsets.UTF_8));
            status.setText("私钥已读入本次内存，登录后清除，不保存文件访问权限。");
        }catch(Exception e){status.setText("无法读取私钥，或超过 64 KB。请选择文本格式私钥。");}
    }
    @Override public void onBackPressed() {
        if(busy) new AlertDialog.Builder(this).setTitle("中止安装并返回？").setMessage("断开可能留下部分安装结果，之后需要重新检测。")
            .setPositiveButton("中止并返回",(d,w)->{cancelWork("已取消");finish();}).setNegativeButton("继续等待",null).show();
        else finish();
    }
    @Override protected void onStop() { super.onStop(); if(!destroyed)cancelWork("页面进入后台，已断开 SSH 并清除凭据；下载计划和已校验缓存保留。可切换网络后重试下载，安装前需重新登录检测。"); }
    @Override protected void onDestroy() {destroyed=true;generation.incrementAndGet();CountDownLatch latch=hostDecision;if(latch!=null)latch.countDown();disconnect();worker.shutdownNow();if(pinnedKey!=null)Arrays.fill(pinnedKey,(byte)0);deleteCache(packageCache);super.onDestroy();}
}
