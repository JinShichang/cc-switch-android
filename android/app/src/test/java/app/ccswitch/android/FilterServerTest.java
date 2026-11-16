package app.ccswitch.android;

import org.junit.Test;
import static org.junit.Assert.*;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.zip.*;

public class FilterServerTest {
    private static final byte[] JSON = "{\"input\":[{\"type\":\"reasoning\"},{\"type\":\"message\",\"id\":\"msg_old\",\"role\":\"user\",\"content\":\"hi\"}]}".getBytes(StandardCharsets.UTF_8);
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c=in.read())!=-1;) { if(c=='\n')break; if(c!='\r')b.write(c); }
        return b.toString(StandardCharsets.US_ASCII);
    }
    private static final class Upstream implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));
        final AtomicInteger calls = new AtomicInteger();
        final AtomicReference<JSONObject> body = new AtomicReference<>();
        final AtomicReference<String> auth = new AtomicReference<>();
        final AtomicReference<Throwable> error = new AtomicReference<>();
        final CountDownLatch completed = new CountDownLatch(1);
        volatile boolean closed;
        Upstream(int status, String response, boolean streaming) throws Exception {
            Thread thread=new Thread(()->{while(!closed)try(Socket client=socket.accept()){
                client.setSoTimeout(5000);InputStream in=client.getInputStream();line(in);Map<String,String> headers=new HashMap<>();
                for(String h;!(h=line(in)).isEmpty();){int colon=h.indexOf(':');headers.put(h.substring(0,colon).toLowerCase(Locale.ROOT),h.substring(colon+1).trim());}
                byte[] request=in.readNBytes(Integer.parseInt(headers.getOrDefault("content-length","0")));
                calls.incrementAndGet();body.set(new JSONObject(new String(request,StandardCharsets.UTF_8)));auth.set(headers.get("authorization"));
                OutputStream out=client.getOutputStream();byte[] bytes=response.getBytes(StandardCharsets.UTF_8);
                out.write(("HTTP/1.1 "+status+" Fixture\r\nConnection: close\r\nContent-Type: "+(streaming?"text/event-stream":"application/json")+"\r\nContent-Length: "+bytes.length+"\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.flush();
                if(streaming){int split=bytes.length/2;out.write(bytes,0,split);out.flush();Thread.sleep(20);out.write(bytes,split,bytes.length-split);}else out.write(bytes);out.flush();completed.countDown();
            }catch(Exception e){if(!closed){error.set(e);completed.countDown();}}},"fixture-upstream");thread.setDaemon(true);thread.start();
        }
        String url(){return "http://127.0.0.1:"+socket.getLocalPort()+"/v1/responses";}
        public void close()throws IOException{closed=true;socket.close();}
    }
    private FilterServer server(String url)throws Exception{return new FilterServer(0,new JSONObject().put("test",new JSONObject().put("url",url).put("apiKey","upstream-fixture")));}
    private String request(FilterServer f,String suffix,String headers,byte[] body)throws Exception{
        try(Socket s=new Socket("127.0.0.1",f.port())){s.setSoTimeout(7000);s.getOutputStream().write(("POST /r/test/"+suffix+" HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer test\r\nContent-Length: "+body.length+"\r\n"+headers+"\r\n").getBytes(StandardCharsets.US_ASCII));s.getOutputStream().write(body);s.getOutputStream().flush();return new String(s.getInputStream().readAllBytes(),StandardCharsets.UTF_8);}
    }
    @Test public void compressedRequestAndSseForwarding()throws Exception{
        String sse="data: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n";
        try(Upstream up=new Upstream(200,sse,true);FilterServer filter=server(up.url())){
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(GZIPOutputStream gz=new GZIPOutputStream(bytes)){gz.write(JSON);}
            String result=request(filter,"responses","Content-Encoding: gzip\r\n",bytes.toByteArray());
            assertTrue(result,result.contains("200 Upstream"));assertTrue(result.endsWith(sse));assertEquals("Bearer upstream-fixture",up.auth.get());assertEquals(1,up.body.get().getJSONArray("input").length());assertFalse(up.body.get().getJSONArray("input").getJSONObject(0).has("id"));assertFalse(up.body.get().getBoolean("store"));assertEquals(1,filter.filtered.get());assertNull(up.error.get());
        }
    }
    @Test public void zstdRequestDecoded()throws Exception{
        try(Upstream up=new Upstream(200,"{}",false);FilterServer f=server(up.url())){
            byte[] compressed=com.github.luben.zstd.Zstd.compress(JSON);
            String result=request(f,"responses","Content-Encoding: zstd\r\n",compressed);
            assertTrue(result,result.contains("200 Upstream"));assertEquals(1,up.body.get().getJSONArray("input").length());
        }
    }
    @Test public void rejectsWithoutForwardingAndKeepsErrorBody()throws Exception{
        try(FilterServer f=server("http://127.0.0.1:1/v1/responses")){
            String a=request(f,"responses","","{\"previous_response_id\":\"old\"}".getBytes());assertTrue(a,a.contains("409 Error"));assertTrue(a.contains("response_reference_not_portable"));assertEquals(0,f.requests.get());
            String b=request(f,"responses/compact","","{}".getBytes());assertTrue(b,b.contains("409 Error"));
            String c=request(f,"responses","Origin: https://example.invalid\r\n","{}".getBytes());assertTrue(c,c.contains("403 Error"));
            String d=request(f,"responses","Content-Encoding: unknown\r\n","{}".getBytes());assertTrue(d,d.contains("415 Error"));
        }
    }
    @Test public void preservesUpstreamHttpFailureNoRetry()throws Exception{
        try(Upstream up=new Upstream(429,"{\"error\":\"fixture upstream failure\"}",false);FilterServer f=server(up.url())){
            String a=request(f,"responses","","{}".getBytes());assertTrue(a,a.contains("429 Upstream"));assertTrue(a.contains("fixture upstream failure"));assertEquals(1,up.calls.get());assertNull(up.error.get());
        }
    }
    @Test public void chunkedInputDoesNotLeakFraming()throws Exception{
        try(Upstream up=new Upstream(200,"{}",false);FilterServer f=server(up.url());Socket s=new Socket("127.0.0.1",f.port())){
            s.setSoTimeout(7000);String h="POST /r/test/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test\r\nTransfer-Encoding: chunked\r\n\r\n";
            s.getOutputStream().write((h+Integer.toHexString(JSON.length)+"\r\n").getBytes(StandardCharsets.US_ASCII));s.getOutputStream().write(JSON);s.getOutputStream().write("\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));s.getOutputStream().flush();
            assertTrue(new String(s.getInputStream().readAllBytes()).contains("200 Upstream"));assertEquals(1,up.body.get().getJSONArray("input").length());
        }
    }
}
