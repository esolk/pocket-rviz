package dev.dot.rosviewer;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Strict package-transfer manifest from the authenticated target's trusted APT index. */
public final class BridgePackagePlan {
    public static final long MAX_TOTAL = 2L * 1024 * 1024 * 1024;
    public final List<Entry> packages;
    public final long totalBytes;
    private BridgePackagePlan(List<Entry> entries, long total) {
        packages = Collections.unmodifiableList(entries); totalBytes = total;
    }
    public static final class Entry {
        public final String url, name, sha256;
        public final long size;
        private Entry(String u, String n, long s, String h) { url=u; name=n; size=s; sha256=h; }
    }
    public static boolean allowedHost(String host) {
        if (host == null) return false;
        String h=host.toLowerCase(java.util.Locale.ROOT);
        return h.equals("packages.ros.org") || h.equals("snapshots.ros.org") ||
            h.equals("archive.ubuntu.com") || h.equals("security.ubuntu.com") ||
            h.equals("ports.ubuntu.com") || h.endsWith(".archive.ubuntu.com");
    }
    public static URI validateUrl(String value) {
        try {
            URI u=new URI(value);
            if (!("https".equals(u.getScheme()) || "http".equals(u.getScheme())) ||
                !allowedHost(u.getHost()) || u.getUserInfo()!=null || u.getFragment()!=null ||
                u.getQuery()!=null || (u.getPort()!=-1 && u.getPort()!=80 && u.getPort()!=443) ||
                u.getPath()==null || !u.getPath().endsWith(".deb")) throw new IllegalArgumentException();
            return u;
        } catch (Exception e) { throw new IllegalArgumentException("软件包地址不是允许的官方 ROS/Ubuntu 来源"); }
    }
    public static BridgePackagePlan parse(String stdout) {
        List<Entry> out=new ArrayList<>(); Set<String> names=new HashSet<>(); long total=0;
        int count=-1;
        for(String line: stdout.split("\\r?\\n")) {
            if(line.startsWith("PLAN_READY ")) { count=Integer.parseInt(line.substring(11).trim()); continue; }
            if(!line.startsWith("PKG\t")) continue;
            String[] p=line.split("\t",-1);
            if(p.length!=5 || !p[2].matches("[A-Za-z0-9_+.%:~\\-]+\\.deb") ||
                p[2].contains("..") || !p[4].matches("[a-f0-9]{64}") || !names.add(p[2]))
                throw new IllegalArgumentException("软件包清单格式异常");
            validateUrl(p[1]);
            long size=Long.parseLong(p[3]);
            if(size<=0 || size>1024L*1024*1024 || out.size()>=256 || total+size>MAX_TOTAL)
                throw new IllegalArgumentException("软件包下载超过安全大小限制");
            total+=size;out.add(new Entry(p[1],p[2],size,p[4]));
        }
        if(out.isEmpty() || count!=out.size()) throw new IllegalArgumentException("没有完整的软件包下载计划");
        return new BridgePackagePlan(out,total);
    }
}
