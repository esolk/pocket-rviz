package dev.dot.rosviewer;
public final class BridgePackagePlanTest {
 static int checks;
 static void ok(boolean b){checks++;if(!b)throw new AssertionError();}
 static void bad(String s){checks++;try{BridgePackagePlan.parse(s);throw new AssertionError(s);}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  String hash="a".repeat(64);
  String valid="PKG\thttp://packages.ros.org/ros/ubuntu/pool/a.deb\ta.deb\t123\t"+hash+"\nPLAN_READY 1\n";
  BridgePackagePlan p=BridgePackagePlan.parse(valid);ok(p.packages.size()==1);ok(p.totalBytes==123);ok(p.packages.get(0).sha256.equals(hash));
  bad(valid.replace("packages.ros.org","evil.invalid"));bad(valid.replace("http://","file://"));
  bad(valid.replace("\ta.deb\t","\t../a.deb\t"));bad(valid.replace(hash,"md5"));
  bad(valid.replace("\t123\t","\t-1\t"));bad(valid.replace("\t123\t","\t1073741825\t"));
  bad(valid.replace("PLAN_READY 1","PLAN_READY 2"));bad(valid+valid);
  bad(valid.replace("packages.ros.org/","user:password@packages.ros.org/"));
  bad(valid.replace("/a.deb\t","/a.deb?token=secret\t"));
  bad("PLAN_READY 0");bad(valid.replace("/a.deb\t","/a.deb#x\t"));
  ok(BridgePackagePlan.allowedHost("ports.ubuntu.com"));ok(!BridgePackagePlan.allowedHost("archive.ubuntu.com.evil.invalid"));
  System.out.println("Bridge package manifest checks: "+checks);
 }
}
