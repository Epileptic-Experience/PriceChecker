import axios from "axios";
import { NextResponse } from "next/server";

export async function GET(request:Request){
    console.log("entro route")
    const {searchParams} = new URL(request.url)
    const query = searchParams.get("q")
    try{
        
        const res = await axios.get("https://api.mercadolibre.com/sites/MLA/search",
            {
                params:{
                    q:query,
                    limit:200
                },
                headers:{
                    "user-agent":"Mozilla/5.0 (windows NT 10.0; win64; x64) ",
                    "Accept": "application/json"

                }
            }

        )
        if(!res){
            return NextResponse.json("no respuesta")
        }

        return NextResponse.json(res.data.results)
    }catch (error){
        if (axios.isAxiosError(error)) {
            console.error("Ocurrio un error al buscar en Mercado Libre", {
                query,
                message: error.message,
                code: error.code,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url: error.config?.url,
                params: error.config?.params,
            })
        } else {
            console.error("Ocurrio un error inesperado al buscar", {
                query,
                error,
            })
        }

        return NextResponse.json({error:error})
    }
}
