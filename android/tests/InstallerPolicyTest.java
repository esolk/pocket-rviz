package dev.dot.rosviewer;
public final class InstallerPolicyTest {
    static int count;
    static void ok(boolean v) {count++;if(!v)throw new AssertionError("check "+count);}
    static void rejects(Runnable r) {boolean failed=false;try{r.run();}catch(IllegalArgumentException e){failed=true;}ok(failed);}
    public static void main(String[] args) {
        ok(InstallerPolicy.host("192.168.1.10").equals("192.168.1.10"));
        ok(InstallerPolicy.host("robot.local").equals("robot.local"));
        ok(InstallerPolicy.host("2001:db8::1").equals("2001:db8::1"));
        rejects(()->InstallerPolicy.host("x; reboot"));rejects(()->InstallerPolicy.host("$(id)"));
        rejects(()->InstallerPolicy.host("ssh://robot"));rejects(()->InstallerPolicy.host("-oProxyCommand=x"));
        rejects(()->InstallerPolicy.host("me@robot"));rejects(()->InstallerPolicy.host("a\nb"));
        ok(InstallerPolicy.user("robot_user").equals("robot_user"));
        rejects(()->InstallerPolicy.user("root"));rejects(()->InstallerPolicy.user("a;id"));
        ok(InstallerPolicy.port("22")==22);rejects(()->InstallerPolicy.port("0"));rejects(()->InstallerPolicy.port("65536"));
        rejects(()->InstallerPolicy.command("abc'", "probe",null));rejects(()->InstallerPolicy.command("YQ==","probe;id",null));
        ok(InstallerPolicy.command("YQ==","install","0123456789abcdef0123456789abcdef").endsWith(" -- install 0123456789abcdef0123456789abcdef"));
        rejects(()->InstallerPolicy.command("YQ==","start","bad;id"));
        ok(InstallerPolicy.cleanLog("\033[31mhello\000").equals("hello"));
        System.out.println("Installer policy: "+count+" checks passed");
    }
}
