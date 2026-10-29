package dev.dot.rosviewer;
import com.jcraft.jsch.*;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
/** Temporary, local fixture keys only; never contacts a server. */
public final class SshIdentityTest {
    public static void main(String[] paths) throws Exception {
        for(String path:paths) {
            JSch ssh=new JSch(); byte[] key=Files.readAllBytes(Paths.get(path));
            byte[] pass="fixture-only-passphrase".getBytes(StandardCharsets.UTF_8);
            try {
                ssh.addIdentity("ephemeral-test",key,null,pass);
                Identity identity=ssh.getIdentityRepository().getIdentities().get(0);
                byte[] signature=identity.getSignature("fixture challenge".getBytes(StandardCharsets.UTF_8));
                if(signature==null || signature.length==0)throw new AssertionError("Signature unavailable");
                System.out.println("Local private-key signature verified available: "+identity.getAlgName());
            }finally{Arrays.fill(key,(byte)0);Arrays.fill(pass,(byte)0);ssh.removeAllIdentity();}
        }
    }
}
