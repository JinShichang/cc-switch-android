use jni::{objects::{GlobalRef, JByteArray, JObject, JString, JValue}, sys::jstring, JNIEnv, JavaVM};
use std::{path::PathBuf, sync::Arc};
struct Saf { vm: Arc<JavaVM>, object: GlobalRef }
impl Saf {
    fn error(env: &mut JNIEnv, source: jni::errors::Error) -> std::io::Error {
        let exception=env.exception_occurred().ok();
        let _ = env.exception_clear();
        let mut detail=format!("SAF 操作失败: {source}");
        let mut kind=std::io::ErrorKind::Other;
        if let Some(exception)=exception.filter(|e|!e.is_null()) {
            if env.is_instance_of(&exception,"java/lang/SecurityException").unwrap_or(false){kind=std::io::ErrorKind::PermissionDenied;}
            if let Ok(value)=env.call_method(&exception,"getMessage","()Ljava/lang/String;",&[]).and_then(|v|v.l()) {
                if !value.is_null(){if let Ok(message)=env.get_string(&JString::from(value)){detail=crate::error_for_log(&message.to_string_lossy());}}
            }
            let _=env.exception_clear();
            let _=env.delete_local_ref(exception);
        }
        std::io::Error::new(kind,detail)
    }
}
impl crate::platform::Documents for Saf {
    fn read(&self,path:&str)->std::io::Result<Option<Vec<u8>>> {
        let mut env=self.vm.attach_current_thread().map_err(|e|std::io::Error::other(e.to_string()))?;
        env.push_local_frame(16).map_err(|e|Self::error(&mut env,e))?;
        let result=(||{
        let name=env.new_string(path).map_err(|e|Self::error(&mut env,e))?;
        let value=env.call_method(self.object.as_obj(),"readDocument","(Ljava/lang/String;)[B",&[JValue::Object(&name)]).map_err(|e|Self::error(&mut env,e))?.l().map_err(|e|Self::error(&mut env,e))?;
        if value.is_null() { return Ok(None); }
        let result=env.convert_byte_array(JByteArray::from(value)).map_err(|e|Self::error(&mut env,e))?;
        Ok(Some(result))
        })();
        unsafe{env.pop_local_frame(&JObject::null()).ok();}result
    }
    fn write(&self,path:&str,bytes:&[u8])->std::io::Result<()> {
        let mut env=self.vm.attach_current_thread().map_err(|e|std::io::Error::other(e.to_string()))?;
        env.push_local_frame(16).map_err(|e|Self::error(&mut env,e))?;
        let result=(||{
        let name=env.new_string(path).map_err(|e|Self::error(&mut env,e))?;
        let data=env.byte_array_from_slice(bytes).map_err(|e|Self::error(&mut env,e))?;
        env.call_method(self.object.as_obj(),"writeDocument","(Ljava/lang/String;[B)V",&[JValue::Object(&name),JValue::Object(&data)]).map_err(|e|Self::error(&mut env,e))?;
        Ok(())
        })();
        unsafe{env.pop_local_frame(&JObject::null()).ok();}result
    }
    fn delete(&self,path:&str)->std::io::Result<()> {
        let mut env=self.vm.attach_current_thread().map_err(|e|std::io::Error::other(e.to_string()))?;
        env.push_local_frame(16).map_err(|e|Self::error(&mut env,e))?;
        let result=(||{
        let name=env.new_string(path).map_err(|e|Self::error(&mut env,e))?;
        env.call_method(self.object.as_obj(),"deleteDocument","(Ljava/lang/String;)V",&[JValue::Object(&name)]).map_err(|e|Self::error(&mut env,e))?;
        Ok(())
        })();
        unsafe{env.pop_local_frame(&JObject::null()).ok();}result
    }
    fn emit(&self,event:&str,payload:&str) {
        let Ok(mut env)=self.vm.attach_current_thread() else {return;};
        if let (Ok(name),Ok(value))=(env.new_string(event),env.new_string(payload)) {
            let result=env.call_method(self.object.as_obj(),"emit","(Ljava/lang/String;Ljava/lang/String;)V",&[JValue::Object(&name),JValue::Object(&value)]);
            if result.is_err(){env.exception_clear().ok();}
            env.delete_local_ref(value).ok();env.delete_local_ref(name).ok();
        }
    }
}
fn result(env:&mut JNIEnv,value:Result<serde_json::Value,String>)->jstring {
    let response=match value {Ok(value)=>serde_json::json!({"ok":true,"result":value}),Err(error)=>serde_json::json!({"ok":false,"error":crate::error_for_log(&error)})};
    env.new_string(response.to_string()).map(JString::into_raw).unwrap_or(std::ptr::null_mut())
}
#[no_mangle]
pub extern "system" fn Java_app_ccswitch_android_NativeCore_initialize(mut env:JNIEnv,object:JObject,home:JString,legacy:JString)->jstring {
    let value=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||->Result<serde_json::Value,String>{
        let path:String=env.get_string(&home).map_err(|e|e.to_string())?.into();
        let text:String=env.get_string(&legacy).map_err(|e|e.to_string())?.into();
        let documents=Arc::new(Saf{vm:Arc::new(env.get_java_vm().map_err(|e|e.to_string())?),object:env.new_global_ref(object).map_err(|e|e.to_string())?});
        crate::api::initialize(PathBuf::from(path),documents,serde_json::from_str(&text).map_err(|e|e.to_string())?)
    })).unwrap_or_else(|_|Err("原生后端初始化失败".into()));
    result(&mut env,value)
}
#[no_mangle]
pub extern "system" fn Java_app_ccswitch_android_NativeCore_dispatch(mut env:JNIEnv,_object:JObject,command:JString,args:JString)->jstring {
    let value=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||->Result<serde_json::Value,String>{
        let name:String=env.get_string(&command).map_err(|e|e.to_string())?.into();
        let text:String=env.get_string(&args).map_err(|e|e.to_string())?.into();
        crate::api::call(&name,serde_json::from_str(&text).map_err(|e|e.to_string())?)
    })).unwrap_or_else(|_|Err("原生后端操作失败；未完成操作会按上游规则恢复".into()));
    result(&mut env,value)
}
