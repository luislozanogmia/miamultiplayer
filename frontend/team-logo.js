(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.MiaTeamLogo=factory();
})(typeof window!=='undefined'?window:this,function(){
  'use strict';
  function valid(value){return typeof value==='string'&&value.length<=43714&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);}
  async function prepare(file){
    if(!file||!['image/png','image/jpeg'].includes(file.type)||file.size>8*1024*1024)throw new Error('Choose a PNG or JPEG image under 8 MB.');
    var image=await createImageBitmap(file);
    try{
      if(!image.width||!image.height||image.width>8192||image.height>8192)throw new Error('Choose an image no larger than 8192 pixels per side.');
      var canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
      var scale=Math.min(128/image.width,128/image.height),w=image.width*scale,h=image.height*scale;
      canvas.getContext('2d').drawImage(image,(128-w)/2,(128-h)/2,w,h);
      var value=canvas.toDataURL('image/png');
      if(!valid(value))throw new Error('This image has too much detail. Choose a simpler logo.');
      return value;
    }finally{image.close();}
  }
  function paint(node,value){
    if(!node||!valid(value))return false;
    var image=node.ownerDocument.createElement('img');image.alt='';image.src=value;
    image.style.cssText='width:100%;height:100%;object-fit:contain;border-radius:inherit';
    image.onload=function(){node.textContent='';node.appendChild(image);};
    return true;
  }
  return {valid:valid,prepare:prepare,paint:paint};
});
