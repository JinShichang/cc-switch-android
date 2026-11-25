package app.ccswitch.android;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** Read-only SAF input adapter. Token parsing, prices, cursors and deduplication
 * remain in upstream session_usage_codex; this cache is never written back. */
final class SessionCache {
    static JSONObject synchronize(Context context,TreeAccess tree) throws Exception {
        byte[] identity=java.security.MessageDigest.getInstance("SHA-256").digest(tree.tree.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder hex=new StringBuilder();for(byte b:identity)hex.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        String scope=hex.toString();
        File root=new File(context.getNoBackupFilesDir(),"upstream/session-cache/"+scope);
        if(!root.isDirectory()&&!root.mkdirs())throw new AppFailure("storage_unavailable","无法创建会话读取缓存。");
        File stampsFile=new File(root,"stamps.json");
        JSONObject previous=stampsFile.isFile()?new JSONObject(new String(Files.readAllBytes(stampsFile.toPath()),StandardCharsets.UTF_8)):new JSONObject();
        JSONObject stamps=new JSONObject();
        JSONObject catalog=new DocumentCatalog(tree).catalog("sessions");
        JSONArray files=catalog.getJSONArray("files"),errors=new JSONArray();
        File indexFile=new File(root,"session_index.jsonl");
        try(InputStream stream=tree.openFile("session_index.jsonl")){
            File temporary=File.createTempFile("saf-index-",".tmp",root);
            try{
                Files.copy(stream,temporary.toPath(),StandardCopyOption.REPLACE_EXISTING);
                Files.move(temporary.toPath(),indexFile.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            }finally{if(temporary.exists())Files.delete(temporary.toPath());}
        }catch(AppFailure failure){
            if(failure.code.equals("file_missing")){Files.deleteIfExists(indexFile.toPath());}
            else errors.put("会话索引读取失败，本次可能缺少自定义标题。");
        }catch(Exception failure){errors.put("会话索引读取失败，本次可能缺少自定义标题。");}
        Set<String> retained=new HashSet<>();
        for(int i=0;i<files.length();i++){
            JSONObject item=files.getJSONObject(i);String path=item.getString("path");
            TreeAccess.validPath(path);
            if(!(path.startsWith("sessions/")||path.startsWith("archived_sessions/"))||
                    !(path.endsWith(".jsonl")||path.endsWith(".jsonl.zst")))continue;
            retained.add(path);
            String stamp=item.optLong("modified")+":"+item.optLong("size",-1);
            File target=new File(root,path);
            try{
                if(item.optLong("modified")>0&&target.isFile()&&stamp.equals(previous.optString(path))){stamps.put(path,stamp);continue;}
                File parent=target.getParentFile();if(!parent.isDirectory()&&!parent.mkdirs())throw new java.io.IOException("缓存目录不可用");
                File temporary=File.createTempFile("saf-session-",".tmp",parent);
                try{
                    try(InputStream stream=tree.openFile(path)){Files.copy(stream,temporary.toPath(),StandardCopyOption.REPLACE_EXISTING);}
                    Files.move(temporary.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
                    long modified=item.optLong("modified");if(modified>0&&!target.setLastModified(modified))throw new java.io.IOException("无法保存会话时间戳");
                    stamps.put(path,stamp);
                }finally{if(temporary.exists()&&!temporary.delete())temporary.deleteOnExit();}
            }catch(Exception failure){errors.put("无法读取会话文件："+path);if(previous.has(path))stamps.put(path,previous.get(path));}
        }
        if(!catalog.optBoolean("truncated")){
            java.util.Iterator<String> keys=previous.keys();
            while(keys.hasNext()){
                String path=keys.next();TreeAccess.validPath(path);
                if(!retained.contains(path)){File obsolete=new File(root,path);if(obsolete.isFile())Files.delete(obsolete.toPath());}
            }
        }else{
            errors.put("会话目录超过扫描边界，当前统计可能不完整。");
            java.util.Iterator<String> keys=previous.keys();while(keys.hasNext()){String path=keys.next();if(!stamps.has(path))stamps.put(path,previous.get(path));}
        }
        Files.write(stampsFile.toPath(),stamps.toString().getBytes(StandardCharsets.UTF_8));
        return new JSONObject().put("errors",errors).put("filesScanned",files.length());
    }
}
