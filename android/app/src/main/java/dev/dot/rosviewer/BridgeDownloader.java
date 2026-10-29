package dev.dot.rosviewer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;

/** Phone-side downloads, bounded by the authenticated APT manifest and SHA-256. No credentials. */
public final class BridgeDownloader {
    public interface Progress { void update(String name, long received, long total); }
    private BridgeDownloader() { }
    public static List<File> download(BridgePackagePlan plan, File cacheDir, Progress progress,
                                      BooleanSupplier canceled) throws Exception {
        if(!cacheDir.isDirectory() && !cacheDir.mkdirs()) throw new IOException("无法创建临时下载目录");
        List<File> files=new ArrayList<>();long done=0;
        for(BridgePackagePlan.Entry entry:plan.packages) {
            if(canceled.getAsBoolean()) throw new IOException("下载已取消");
            File target=new File(cacheDir,entry.name), part=new File(cacheDir,entry.name+".part");
            if (verifiedFile(target, entry)) { files.add(target); done+=entry.size; progress.update(entry.name,done,plan.totalBytes); continue; }
            HttpURLConnection conn=null;
            try {
                URI uri=BridgePackagePlan.validateUrl(entry.url);
                // HTTP package transport is permitted only with the SHA-256 supplied by trusted,
                // authenticated target APT metadata. TLS errors are never bypassed or downgraded.
                for(int redirects=0;;redirects++) {
                    conn=(HttpURLConnection)uri.toURL().openConnection();
                    conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(15000);conn.setReadTimeout(15000);
                    conn.setRequestProperty("Accept-Encoding","identity");
                    int code=conn.getResponseCode();
                    if(code>=300 && code<400) {
                        if(redirects>=3) throw new IOException("下载重定向过多");
                        String location=conn.getHeaderField("Location");
                        if(location==null) throw new IOException("下载重定向缺少地址");
                        URI next=BridgePackagePlan.validateUrl(uri.resolve(location).toString());
                        if("https".equals(uri.getScheme()) && !"https".equals(next.getScheme()))
                            throw new IOException("拒绝从 HTTPS 降级下载");
                        conn.disconnect();uri=next;continue;
                    }
                    if(code!=200) throw new IOException("官方软件源返回 HTTP "+code);
                    break;
                }
                long length=conn.getContentLengthLong();
                if(length>=0 && length!=entry.size) throw new IOException("软件包大小与清单不一致");
                MessageDigest hash=MessageDigest.getInstance("SHA-256");long received=0;
                try(InputStream in=conn.getInputStream();FileOutputStream out=new FileOutputStream(part)) {
                    byte[] buf=new byte[65536];int n;
                    while((n=in.read(buf))!=-1) {
                        if(canceled.getAsBoolean()) throw new IOException("下载已取消");
                        received+=n;if(received>entry.size) throw new IOException("软件包超出清单大小");
                        hash.update(buf,0,n);out.write(buf,0,n);progress.update(entry.name,done+received,plan.totalBytes);
                    }
                }
                if(received!=entry.size || !hex(hash.digest()).equals(entry.sha256))
                    throw new IOException("软件包 SHA-256 或长度校验失败，未上传安装");
                if(target.exists() && !target.delete()) throw new IOException("无法替换临时下载文件");
                if(!part.renameTo(target)) throw new IOException("无法保存下载文件");
                files.add(target);done+=received;
            } finally { if(conn!=null) conn.disconnect(); if(part.exists()) part.delete(); }
        }
        return files;
    }
    public static boolean verifiedFile(File file, BridgePackagePlan.Entry entry) throws Exception {
        if(!file.isFile() || file.length()!=entry.size) return false;
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new java.io.FileInputStream(file)) {
            byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);
        }
        return hex(digest.digest()).equals(entry.sha256);
    }
    private static String hex(byte[] bytes) { StringBuilder b=new StringBuilder();for(byte x:bytes)b.append(String.format(java.util.Locale.ROOT,"%02x",x&255));return b.toString(); }
}
